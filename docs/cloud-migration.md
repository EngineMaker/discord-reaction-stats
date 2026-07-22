# クラウド移行の実装ログ（2026-07 完了・アーカイブ）

TypeScript化 → Neon化 → GitHub Actions月イチ集計 → Cloudflare Pages/Discord OAuth閲覧ページ、の順で移行した記録。**すべて完了・本番稼働中。** 日常の作業では読む必要はなく、当時の判断の根拠を掘り返すとき用に残している。CLAUDE.md 本体には要点だけ置いてある。

移行を①②③④同時ではなくこの順で1つずつ進めたのは、同時に変えると問題の切り分けができなくなるため。

## ① TypeScript 化（2026-07-23 完了）
- src の5ファイルと test を `.ts` 化。`tsx` を devDependency に入れ、`node --import tsx src/xxx.ts` で実行（ビルド不要）。
- 型チェックは `npm run typecheck`。行の型は `db.ts` に集約 (`UserRow` 等) し `.all() as XxxRow[]` で受ける。
- `tsconfig` は `strict:false`（段階的に締める余地あり。次は strictNullChecks）。
- `report.ts`（当時）の HTML内埋め込みJS はテンプレート文字列のまま（型の恩恵薄い）。
- **検証**: `npm test` 全項目パス / スナップDBからのレポート生成が旧版と同一（合計デフォルト・カットオフ・戻る・EM住民フィルタ全て動作、JSエラーなし）。ロジックは一切変えていない。

## ② Neon (Postgres) 化（2026-07-23 完了）
- Neonプロジェクト名 `emaker` / DB名 `discord_reaction_stats`。接続情報は `.env` の `DATABASE_URL`（コミット禁止・トークン同様の扱い）。
- `db.ts` を `pg.Pool` に置換、`openDb` は非同期に。`scan.ts`/`report.ts` は `await` 対応。
- **`db.transaction()` は `pg` に無いので `inTransaction()` ヘルパを自作**（`db.connect()` で1本取り出し `BEGIN`〜`COMMIT`/`ROLLBACK`）。1バッチ=1トランザクションの取りこぼし防止は維持。**プールの `query` は毎回別接続になりうるので、トランザクションは必ずクライアントを固定すること。**
- プレースホルダ `?` → `$1,$2...`、`INSERT OR IGNORE` → `ON CONFLICT ... DO NOTHING`、`ON CONFLICT DO UPDATE`/`excluded` はそのまま通る、`= 1` 比較も維持。
- `message_ts` は `BIGINT`（Postgres の INTEGER は32bitで溢れる）。`COUNT(*)` は bigint=文字列で返るので `::int` キャストで数値化。
- `report`/`scan` とも実行時に `.env` 必須。プールは末尾で `await db.end()`（閉じないとハングする）。
- 既存SQLite→Neon はワンショット移行スクリプト `scripts/migrate-to-neon.ts`（冪等、件数一致を自己検証）で実施済み。SQLite(`data.sqlite`) と `better-sqlite3` 依存はこの移行のためだけに残っている。
- **検証**: 移行後 users=178/reactions=3819/messages=4392/scan_state=660 が SQLite と完全一致、Neon由来レポートが SQLite版と同一（tokisaba 合計605で先頭・EM住民20人・カットオフ・戻る全て一致、JSエラーなし）。

## ③ GitHub Actions で月イチ集計（2026-07-23 疎通確認完了）
- リポジトリ **https://github.com/EngineMaker/discord-reaction-stats** (パブリック確定)。Secrets 3つ登録済み。
- `workflow_dispatch` で `2026-07` を手動実行し **success で完走**（CIから Discord 認証・Neon 書き込み・再開スキップ全て正常。508対象/354スレッド、532リアクション記録）。ファイルは `.github/workflows/monthly-scan.yml`。
- **教訓**: `2026-07` 単独指定は `period_key="2026-07"` となり、前回の複合指定 (`"2026-06,2026-07"`) と別扱い → 新規スキャン扱いで660件を最初から走り約26分（設計通り。速いスキップにはならない）。GitHub の Webログ表示は途中で滞留することがあり止まって見えるが、**Neon の実数が真実**。進捗は `scripts/progress.ts [YYYY-MM]` で確認する。
- レート制限は「遅いが正常に流れる」と実測。月イチ本番なら20〜30分でも `timeout-minutes:120` 内で問題なし。
- cron `0 22 1 * *`（UTC月初22時 = JST 2日7時。JST6時境界を確実に跨いだ後）。
- 集計期間は `scripts/target-period.ts` が「今のJST時刻が属する期間の前月」を出力（年またぎ対応済み・テスト済み）。手動入力があればそれを優先。
- Secrets 必要: `DISCORD_TOKEN` / `GUILD_ID` / `DATABASE_URL`。CI では `.env` が無く `--env-file-if-exists` はスキップされ、env は Secrets 経由で直接渡る。
- **注意**: 60日コミット無しでワークフロー自動無効化（`workflow_dispatch` があるので手動で叩けば復活）。

## ④ Cloudflare Pages + Discord OAuth 閲覧ページ（2026-07-23 コード実装+ローカル確認完了）
- `functions/` に Pages Functions: `index.ts`(/ セッション検証→レポート or ログイン画面) / `auth/login.ts`(Discordへ302, state発行) / `auth/callback.ts`(★核心: コード交換→**対象サーバーのメンバー確認**→署名Cookie発行) / `auth/logout.ts` / `_lib/session.ts`(HMAC-SHA256署名Cookie, crypto.subtle) / `_lib/discord.ts`(OAuth, identify+guilds)。
- **メンバー確認が済むまでデータを一切配信しない**を実装（未ログイン `/` はログイン画面のみ、レポート本体マーカー0を確認済み）。スコープ `identify`+`guilds` のみ。
- **HTML生成は `src/build-report.ts` の `buildReportHtml(db)` に切り出して CLI と共有**（HTMLテンプレートは旧 report.ts と1バイトも変えていないことを diff で確認済み）。`report.ts` は薄いCLIラッパに。DB引数は `Queryable` 最小IFで pg(CLI)/@neondatabase/serverless(Functions) 両対応。
- Functions は Workers ランタイム: `@neondatabase/serverless` で Neon 接続（通常の pg TCP は Workers で不可）、`functions/tsconfig.json` で Workers 型チェック。
- ローカル: `.dev.vars`（`.env` + `SESSION_SECRET`、gitignore済）で `npm run dev`。**Discord実ログイン→メンバー確認→レポート表示のフル通しがローカルで成功済み。**
- Discord Developer Portal: 既存Botアプリに OAuth2 リダイレクトURI 2つ登録済み（`http://localhost:8788/auth/callback` と `https://reactions.emaker.dev/auth/callback`）。
- 本番の環境変数5つ: `DATABASE_URL` / `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` / `GUILD_ID` / `SESSION_SECRET`（本番用は新規生成＝会話ログに残った値は使わない）。
- `wrangler.jsonc` の compatibility_date は wrangler がサポートする過去日にすること（未来日で起動失敗した）。

## 却下した案
- CockroachDB（分散はこの規模で過剰）
- クエリ文字列パスワード（データが手元にある時点でザル）
- GitHub・Google 認証（メンバーの該当アカウントを把握できない）

## ドメイン
**`emaker.dev`**（EngineMaker の略）。このツールはシェアハウス EngineMaker 全体のものという位置づけ。Cloudflare Registrar で取得（`.dev`は直接取得可・原価・NS設定不要）。`.dev` はHTTPS必須だが Pages が証明書自動発行。閲覧ページは `reactions.emaker.dev`。

## 保留中の小さな宿題（実害なし・ユーザー操作）
- `.env` の接続文字列を `sslmode=verify-full` に変えると pg の SSL 警告が消える（現状も verify-full 相当で動作している）。
