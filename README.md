# Discord リアクション集計

Discord ギルドのリアクションを「もらった数 / 付けた数」でメンバー別・リアクション別に集計し、自己完結の HTML レポートを出力する。投稿数も併せて集計する。

集計期間は**日本時間の月単位、日付変更は毎朝 6:00 JST**。つまり 2026-06 期は `2026/6/1 06:00 JST 〜 2026/7/1 06:00 JST`。

## 全体構成

このツールはクラウドで月イチ稼働している。ローカルからも同じスクリプトで動かせる。

| 役割 | 実体 | 実装 |
|---|---|---|
| データ収集（スキャン） | Discord 履歴を遡って Neon に書く | `src/scan.ts`（ローカル）/ GitHub Actions（月イチ自動） |
| データ保存 | Neon (Postgres) | `src/db.ts` |
| レポート生成 | 自己完結 HTML | `src/build-report.ts`（本体）/ `src/report.ts`（CLI ラッパ） |
| 閲覧ページ | Cloudflare Pages + Discord OAuth | `functions/` |

- ソースは TypeScript。ビルドは不要で、`tsx` 経由で `.ts` を直接実行する（`node --import tsx ...`）。
- 型チェックは `npm run typecheck`（Node 側と Cloudflare Functions 側の両方を走らせる）。
- データストアは **Neon (Postgres)**。接続文字列は `.env` の `DATABASE_URL`（コミット禁止・トークン同様の扱い）。
- `better-sqlite3` と `data.sqlite` は、旧 SQLite 版からの一回限りの移行（`scripts/migrate-to-neon.ts`）のためだけに残っている。

## 準備

### 1. Bot の作成と権限

1. https://discord.com/developers/applications で New Application → Bot を作成
2. **Privileged Gateway Intents** の **Server Members Intent** を ON（メンバー表示名の取得に必要）
3. OAuth2 → URL Generator で `bot` スコープ、権限は **View Channels** と **Read Message History** を選択し、生成された URL でギルドに招待

> Bot が閲覧権限を持たないチャンネルは自動でスキップされる。全部を集計したいなら Bot ロールに全チャンネルの閲覧権限を与えること。

Bot 権限は **チャンネルを表示** と **メッセージ履歴を読む** の2つだけでよい（Permissions Integer = `66560`）。`管理者` は付けないこと — チャンネル個別の権限設定を無視してしまうため、トークンが漏れたときの被害が桁違いになる。

Message Content Intent は不要（本文は読まないため）。必要なのは **SERVER MEMBERS INTENT** のみ。

### 2. 依存関係

```sh
npm install
```

### 3. 認証情報

`.env.example` を `.env` にコピーして値を入れる:

```sh
cp .env.example .env
```

```
DISCORD_TOKEN=xxx
GUILD_ID=yyy
DATABASE_URL=postgres://...        # Neon の接続文字列
```

`.env` は `.gitignore` 済み。Node の `--env-file-if-exists` で読むので追加の依存は不要。環境変数を直接渡した場合はそちらが優先される（GitHub Actions では `.env` が無く Secrets から直接渡る）。

## 使い方（ローカル）

```sh
# 0. Bot がどのサーバーに参加しているか確認（GUILD_ID の切り分け用）
npm run whoami

# 1. 履歴をスキャンして Neon に蓄積（期間は複数指定可）
npm run scan -- 2026-06

# 2. HTML レポートを生成
npm run report          # report.html が出力される
npm run report -- --include-bots   # Bot も集計対象に含める
```

`report.html` はブラウザで開くだけで動く。外部リソースへの依存は Discord の絵文字・アバター画像のみ。

## レポートでできること

- 期間の切り替え、「合計 / もらった数 / 付けた数 / 投稿数」の並べ替え（**デフォルトは合計**）
- KPI（総数・参加人数・絵文字の種類数・投稿数）
- メンバー別ランキング → 行クリックで**そのメンバーの詳細**（もらった絵文字の内訳／誰からもらったか／付けた絵文字の内訳／誰に付けたか）
- リアクション別内訳 → 行クリックで**その絵文字の詳細**（よくもらった人／よく付けた人）
- ブラウザの戻るボタン・画面内の「← 一覧に戻る」で一覧へ戻れる

## 仕様上の注意

- **合計 = もらった + 付けた + 投稿。** 合計が **32 未満**のメンバーはその月は表示しない（隠した人数は表フッタに出す）。EM住民ロールの人は 0 件でもランキングに載せる。
- **自分のメッセージへの自分のリアクションは除外**している（自己リアクションで数字が盛れるのを防ぐため）。含めたい場合は `src/build-report.ts` の SQL で `giver_id != receiver_id` を外す。
- Bot はデフォルトで除外（`--include-bots` で変更可）。
- 表示名は**サーバーのニックネームを優先**する（グローバル表示名ではない）。直すには再スキャンが必要。
- **後から外されたリアクションは復元できない。** 履歴スキャンはスキャン時点で残っているリアクションを見るだけなので、「付けたが後で取り消した」分は数に入らない。厳密に追うならリアルタイム収集（下記）が必要。
- キーキャップ絵文字（`0️⃣`〜`9️⃣` 等）は Discord API の制約で「誰が付けたか」を取得できない。件数は取れるので、集計できなかった分はスキャン末尾に報告される。
- 再実行しても `ON CONFLICT DO NOTHING` で重複は入らないので、同じ期間を何度スキャンしても安全。

## 中断と再開

**スキャンが途中で落ちても、同じコマンドを再実行すれば続きから再開する。**

進捗はチャンネル単位・期間単位で `scan_state` に保存される。1バッチ（100メッセージ）ごとに、リアクションの書き込みと「どこまで遡ったか」の記録を同一トランザクションでコミットしているので、どのタイミングで落ちても取りこぼしも二重計上も起きない。走査済みのチャンネルは API を一切叩かずスキップされる。

```sh
npm run scan -- 2026-06            # 中断しても同じコマンドで再開
npm run scan -- 2026-06 --fresh    # 進捗を捨てて最初から走査し直す
```

進捗は「指定した期間の組み合わせ」ごとに独立しているので、`2026-06` を完走した後に `2026-07` を走らせても正しく走査される。

`--fresh` が要るのは、後から Bot の閲覧権限を追加したときなど、**もう一度同じ範囲を取り直したい場合**だけ。既存のリアクションデータは消えない（消えるのは進捗記録のみ）。

- フォーラム／スレッド（アーカイブ済み含む）も走査対象。器そのもの（フォーラムチャンネル本体）はメッセージを持たないので対象外。
- チャンネル数・メッセージ数が多いとレート制限で時間がかかる。discord.js が自動で待機するのでそのまま放置してよい。
- スキャンの進捗は `node --env-file-if-exists=.env --import tsx scripts/progress.ts [YYYY-MM]` で Neon の実数を確認できる（GitHub の Web ログが滞留して見えるときの真偽判定に使う）。

## 月イチ自動集計（GitHub Actions）

`.github/workflows/monthly-scan.yml` が毎月 **1日 UTC 22:00（= JST 2日 07:00）** に前月分を自動スキャンする。JST 6時始まりの月境界を確実に跨いだ後に走らせている。

- 集計期間は `scripts/target-period.ts` が「今の JST 時刻が属する期間の前月」を出力する（年またぎ対応）。
- `workflow_dispatch` で手動実行も可能。`period` 入力で過去分を再集計、`fresh` で `--fresh`。
- 必要な Secrets: `DISCORD_TOKEN` / `GUILD_ID` / `DATABASE_URL`。
- `concurrency` で直列化（`scan_state` の取り合い防止）、`timeout-minutes: 120`。
- **注意**: 60日コミットが無いとワークフローが自動無効化される。`workflow_dispatch` を手動で叩けば復活する。

## 閲覧ページ（Cloudflare Pages + Discord OAuth）

メンバー限定でレポートを閲覧するページ。`functions/` の Pages Functions で動的生成する（静的アセットは持たず、Pages が要求する出力ディレクトリとして空の `public/` を置いている）。

- `/` … セッションを検証し、正当ならレポート、そうでなければログイン画面。
- `auth/login.ts` … Discord へリダイレクト（`identify` + `guilds` スコープ、state 発行）。
- `auth/callback.ts` … コード交換 → **対象サーバーのメンバーかを確認** → 署名 Cookie を発行。**メンバー確認が済むまでレポートデータを一切配信しない。**
- `auth/logout.ts` / `_lib/session.ts`（HMAC-SHA256 署名 Cookie）/ `_lib/discord.ts`（OAuth）。
- HTML 生成は CLI と同じ `src/build-report.ts` を共有する。Neon 接続は Workers ランタイムのため `@neondatabase/serverless` を使う（通常の `pg` TCP は Workers で不可）。

### ローカルで動かす

```sh
npm run dev            # = wrangler pages dev
```

`.dev.vars`（`.env` の内容 + `SESSION_SECRET`、`.gitignore` 済み）を読み込む。Discord Developer Portal の OAuth2 リダイレクト URI に `http://localhost:8788/auth/callback` を登録しておくこと。

### 本番

`https://reactions.emaker.dev/` で稼働。環境変数は `DATABASE_URL` / `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` / `GUILD_ID` / `SESSION_SECRET`（本番用は新規生成）。

## 今後: リアルタイム収集

運用を始めるなら `messageReactionAdd` / `messageReactionRemove` を購読する常駐 Bot を足すと、取り消し分も含めて正確に取れる。既存の `reactions` テーブルにそのまま書き込めばレポート側は変更不要。
