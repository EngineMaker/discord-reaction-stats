# 作業ログ — discord-reaction-stats

> **迷ったらここだけ読めば戻れます。** 詳細は下に追記式で続きます。

## 🔖 いまの状況（2026-08-22 時点）

**このプロジェクトは何**: Discord サーバー（シェアハウス EngineMaker）のリアクションを
「もらった数 / 付けた数 / 投稿数」でメンバー別に月イチ集計し、HTML レポートとして
メンバー限定で見せるツール。**クラウド移行は完了済みで、すでに本番稼働している。**
公開先は https://reactions.emaker.dev/（Discord OAuth でサーバーメンバーのみ閲覧可）。

| | 状態 |
|---|---|
| **① TypeScript 化** | ✅ 完了（2026-07-23） |
| **② Neon (Postgres) 化** | ✅ 完了（2026-07-23）。旧 SQLite からの移行済み |
| **③ GitHub Actions 月イチ集計** | ✅ 完了・**自動実行が実績を出した**（2026-08-02 の初 cron が success） |
| **④ Cloudflare Pages + Discord OAuth 閲覧ページ** | ✅ 完了・本番稼働中 |
| **⑤ 60日無コミットによる Actions 自動無効化** | ⚠️ **要注意。期限が近い（下記）** |
| **⑥ Node 20 deprecation 警告** | ⏳ 未対応（動いてはいる） |
| **⑦ 常駐 Bot 化（リアルタイム収集）** | 💤 構想のみ・未着手 |

**つまり、機能開発としては一段落していて、いまは「放っておくと壊れるところ」の面倒を見る局面。**

### 👉 次にやること

1. **9/21 までに何か1つコミットして push する**（GitHub Actions は 60 日コミットが無いと
   ワークフローが自動無効化される。最終コミットが 2026-07-23 なので、**目安 2026-09-21 が期限**。
   すでに 30 日経過）。無効化されても `gh workflow run monthly-scan.yml` で復活はできるが、
   気づかないと 9 月分の集計が黙って飛ぶ
2. **2026-08 分の集計が 9/2 朝に自動で走るか見届ける**（cron `0 22 1 * *` = JST 2日 7:00）。
   結果は `gh run list --workflow=monthly-scan.yml` で確認。実データは
   `node --env-file-if-exists=.env --import tsx scripts/progress.ts 2026-08`
3. **Node 20 deprecation 警告への対応を検討**（8/2 の run に出た。`actions/checkout@v4` /
   `actions/setup-node@v4` を v5 系に上げる。今は強制的に Node 24 で動いていて実害はない）
4. **保留中の宿題（実害なし）**: `.env` の `DATABASE_URL` に `sslmode=verify-full` を付けると
   pg の SSL 警告が消える。ユーザー操作（トークンを含むので代理実行しない）

---

## 復帰用コマンド

```sh
# 開発
npm install
npm run whoami                 # Bot がどのサーバーにいるか（GUILD_ID の切り分け）
npm run scan -- 2026-08        # 履歴スキャン → Neon に蓄積（中断しても同じコマンドで再開）
npm run scan -- 2026-08 --fresh  # 進捗だけリセットして最初から
npm run report                 # report.html を生成（gitignore 済み）
npm run typecheck              # tsc（Node 側 + functions 側の両方）
npm test                       # test/threads.test.ts（偽 Discord API に対する検証）

# 閲覧ページ（Cloudflare Pages Functions）をローカルで
npm run dev                    # = wrangler pages dev。localhost:8788。.dev.vars を読む

# 運用スクリプト（すべて DATABASE_URL を使うのでユーザー実行）
node --env-file-if-exists=.env --import tsx scripts/progress.ts 2026-08       # Neon の実数を確認
node --env-file-if-exists=.env --import tsx scripts/delete-period.ts 2026-08  # dry-run 既定
node --env-file-if-exists=.env --import tsx scripts/delete-period.ts 2026-08 --commit

# GitHub Actions
gh run list --workflow=monthly-scan.yml
gh workflow run monthly-scan.yml -f period=2026-08     # 手動で再集計
```

`.env`（`DISCORD_TOKEN` / `GUILD_ID` / `DATABASE_URL`）と `.dev.vars`（`.env` の内容 + `SESSION_SECRET`）
はどちらも gitignore 済み・存在する。**中身は読まない・書き写さない。**

## 押さえておく座標

- **リポジトリ**: https://github.com/EngineMaker/discord-reaction-stats（パブリック・org は EngineMaker）
- **本番**: https://reactions.emaker.dev/（Cloudflare Pages。プロジェクト名 `emaker-reactions`）
- **DB**: Neon プロジェクト `emaker` / DB `discord_reaction_stats`
- **ドメイン**: `emaker.dev`（2026-07-23 に Cloudflare Registrar で取得。$12.20/年）。
  **失効するとシェアハウス全体のサービスが止まる**ので auto-renew は ON にしておくこと
- **集計期間の定義**: JST 6:00 始まりの月。`2026-06` 期 = `2026/6/1 06:00 JST 〜 2026/7/1 06:00 JST`

設計上の判断・踏んだエラーの手引きは `CLAUDE.md`、移行時の実装詳細は `docs/cloud-migration.md` に
アーカイブしてある。このファイルは「経緯と現在地」だけを持つ。

---

## 2026-07-22 — クラウド移行の方針が固まる

書き捨てローカルスクリプト（Node + SQLite）だったものを、仕様追加に耐える形へ移す方針を決定。
**① TypeScript化 → ② Neon化 → ③ Actions 月イチ → ④ OAuth 閲覧ページ** の順で1つずつ進める
（同時に変えると問題の切り分けができなくなるため）。

- 言語は TypeScript。`discord.js` で積んだ資産（レート制限 / ページング / スレッド展開 /
  キーキャップ絵文字 10014 対処 / 再開ロジック）を捨てずに運べるのが理由
- DB は Neon。scale-to-zero が月イチ実行と相性がよい。**CockroachDB は不採用**（分散が解く問題が
  この規模で発生せず過剰）
- 閲覧の認証は **Discord OAuth 一択**。ユーザーは対象メンバーの GitHub / Google / メールを一切
  把握しておらず、分かるのは Discord アカウントだけ。集計対象サーバーと認証サーバーが同一なので
  「レポートに載るサーバーのメンバーだけが見られる」と境界が閉じる
- **却下した案**: クエリ文字列パスワード・静的 JS チェック（データが手元にある時点でザル）、
  GitHub / Google 認証（アカウントを把握できない）

同日、`emaker.dev` を Cloudflare Registrar で取得。

## 2026-07-23 — ①〜④ を一気に完走、本番稼働へ

**1日で全部通した。** 検証結果込みの詳細は `docs/cloud-migration.md` にある。要点だけ:

- **①**: src 5ファイル + test を `.ts` 化。ビルドはせず `tsx` で `.ts` を直接実行する方式。
  `tsconfig` は `strict:false`（締める余地あり。次は `strictNullChecks`）
- **②**: 移行後の件数が SQLite と完全一致（users=178 / reactions=3819 / messages=4392 /
  scan_state=660）。レポート出力も旧版と同一であることを確認
- **③**: `workflow_dispatch` で `2026-07` を手動実行し success で完走（31分51秒）。
  **教訓**: `2026-07` 単独指定は `period_key` が前回の複合指定 `"2026-06,2026-07"` と別扱いになり
  新規スキャン扱いで最初から走る（設計通り）。GitHub の Web ログは滞留して止まって見えることが
  あるが、**Neon の実数が真実**（`scripts/progress.ts` で見る）
- **④**: デプロイで踏んだ罠 — Cloudflare Pages の環境変数 / Secret は **登録後に再デプロイして
  初めて反映される**。「デプロイ → Secret 登録」の順にすると env が undefined になる
  （`client_id=undefined` で発覚）。再デプロイで解決
- wrangler をローカル devDependency 化（npx の都度 DL を回避）。`sharp` の high 脆弱性は
  wrangler → miniflare の間接依存でアプリ実行経路になく、実害なし・放置でよい

### 同日: 7月分の疎通確認データを削除した

③ の疎通確認で Neon に入った 2026-07 のデータ（reactions 1943 / messages 2330 / scan_state 507）を
`scripts/delete-period.ts 2026-07 --commit` で削除。8/1 の月イチバッチに正しく取り直させるため。

**この時点で Neon にあるのは 2026-06 のみ**（rx 2408 / msg 3374 / done_ch 507）だった。

削除スクリプトは `reactions` / `messages` / `scan_state` を 1 トランザクションでまとめて消す。
**`scan_state` を消し忘れると次のバッチが走査済みと誤判定してスキップする**ので、この 3 点セットは崩さないこと。

同日の最終コミット `c3f4f5d`「ドキュメント刷新: README を現構成に合わせ、CLAUDE.md をスリム化」で
一段落。**以降このリポジトリにコミットは無い（= 作業ツリーもクリーン）。**

## 2026-08-01 — 「7月分の集計がされてない気がする」→ 誤報だった

ユーザーから「8月になったのに7月分の集計がなされてない気がするよ」。調べた結論は
**まだ実行時刻が来ていなかっただけ**。

- cron は `0 22 1 * *` = UTC 8/1 22:00 = **JST 8/2 07:00**。質問時点は JST 8/1 16:59 で、
  予定まであと 14 時間あった。JST 6 時始まりの月境界を確実に跨いでから走らせる意図的な設計
- ワークフローの state は `active`（60日無コミットの自動無効化はまだ起きていなかった）
- 当時の実行履歴は 7/22 の `workflow_dispatch` 1件（疎通確認）のみで、scheduled は未発火

**この日の会話はここで途切れている。** 「明日を待たずに今すぐ手動実行しますか?」と聞いたが、
ユーザーの返事はない（結果的に手動実行は不要だった。下記）。

## 2026-08-22 — 現状確認（このログ作成時点で調べたこと）

WORKLOG 作成にあたって実際に叩いて確認した事実:

- **2026-08-02 の初回 scheduled 実行は success で完走している**
  （run id `30722307042`、trigger `schedule`、開始 2026-08-01T22:55:47Z、所要 **1時間17分25秒**）。
  → 8/1 のユーザーの心配は杞憂で、**7月分は自動で取れた**。月イチ自動集計は実績として動いた
- ただしこの run に **`Node.js 20 is deprecated` の annotation** が付いている
  （`actions/checkout@v4` / `actions/setup-node@v4` が Node 24 に強制されて動いている）。
  現時点で失敗はしていないが、いずれ対応が要る
- ワークフローの state は今も `active`。ただし**最終コミットが 2026-07-23 で 30 日経過**。
  60 日無コミットの自動無効化まで残り約 30 日（**目安 2026-09-21**）
- git: ブランチ `main`、`origin/main` と同期済み、**作業ツリーはクリーン**（未コミットの変更なし）

**未確認 / 不明なこと（推測で埋めていない）**:
- Neon に 2026-07 のデータが実際に何件入ったかは未確認（`DATABASE_URL` を使うため、確認は
  `scripts/progress.ts 2026-07` をユーザー実行してもらう必要がある）
- 8/2 の run の詳細ログは `gh run view --log` で取得できなかった（ログ保持期間切れとみられる）
- 本番ページ https://reactions.emaker.dev/ の稼働は今回ブラウザで確認していない
- ユーザーが 7 月分のレポートを実際に見たかどうかは不明

---

## 積み残し・アイデア（急がないもの）

- **常駐 Bot 化（リアルタイム収集）**: 履歴スキャン方式の根本制約として
  **取り消されたリアクションは復元できない**（スキャン時点で残っているものしか見えない）。
  月イチ運用にするとこの制約はより顕在化する。`messageReactionAdd` / `messageReactionRemove` を
  購読する常駐 Bot を足せば正確に取れる。**既存の `reactions` テーブルにそのまま書けるので
  レポート側は変更不要。** ユーザーは「運用を始めたら検討したい」と言っていた
- `tsconfig` の `strict` を段階的に締める（次は `strictNullChecks`）
- `.env` の `sslmode=verify-full` 化（pg の SSL 警告が消えるだけ。実害なし）
- `data.sqlite` と `better-sqlite3` 依存は Neon への一回限りの移行のためだけに残っている。
  移行は完了しているので、いずれ落とせる
