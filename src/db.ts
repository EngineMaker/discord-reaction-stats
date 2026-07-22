import Database from 'better-sqlite3';

export type Db = Database.Database;

// SELECT で読み出す行の形。report / scan から参照する。
export interface UserRow {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  is_bot: number;
  is_member: number;
  roles: string; // JSON 配列の文字列
}

export interface ReactionRow {
  period: string;
  emoji_key: string;
  emoji_label: string;
  emoji_url: string | null;
  giver_id: string;
  receiver_id: string;
}

export interface PostCountRow {
  period: string;
  author_id: string;
  n: number;
}

export interface ScanStateRow {
  oldest_seen_id: string | null;
  completed: number;
}

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS reactions (
      message_id   TEXT NOT NULL,
      channel_id   TEXT NOT NULL,
      emoji_key    TEXT NOT NULL,  -- カスタム絵文字は ID、標準絵文字は文字そのもの
      emoji_label  TEXT NOT NULL,  -- 表示用（:name: または絵文字）
      emoji_url    TEXT,           -- カスタム絵文字の画像URL
      giver_id     TEXT NOT NULL,  -- リアクションを付けた人
      receiver_id  TEXT NOT NULL,  -- メッセージの投稿者
      message_ts   INTEGER NOT NULL, -- メッセージ投稿時刻(UTC ms)
      period       TEXT NOT NULL,
      PRIMARY KEY (message_id, emoji_key, giver_id)
    );
    CREATE INDEX IF NOT EXISTS idx_period ON reactions(period);

    CREATE TABLE IF NOT EXISTS users (
      user_id      TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      avatar_url   TEXT,
      is_bot       INTEGER NOT NULL DEFAULT 0,
      -- ギルドの現メンバーか。リアクション経由でしか知らない相手（退会者など）は 0。
      is_member    INTEGER NOT NULL DEFAULT 0,
      -- 所持ロール名を JSON 配列で保持。ロール名は変わりうるので ID ではなく名前で持ち、
      -- レポート側は名前で絞り込む（絞り込み対象が増えてもスキーマを変えずに済む）。
      roles        TEXT NOT NULL DEFAULT '[]'
    );

    -- 投稿そのもの。リアクションの有無に関わらず全件記録する（投稿数の集計用）。
    -- reactions と違い「1メッセージ = 1行」なので主キーは message_id だけでよい。
    -- INSERT OR IGNORE なので同じ期間を何度走査しても二重計上しない。
    CREATE TABLE IF NOT EXISTS messages (
      message_id  TEXT PRIMARY KEY,
      channel_id  TEXT NOT NULL,
      author_id   TEXT NOT NULL,
      message_ts  INTEGER NOT NULL,
      period      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_period ON messages(period);

    -- 走査進捗。中断しても途中から再開できるようにする。
    -- 走査は新しい順に遡るので oldest_seen_id が「どこまで遡ったか」を表す。
    -- 期間ごとに独立させる（6月走査済みの状態で7月を走らせても誤判定しないように）。
    CREATE TABLE IF NOT EXISTS scan_state (
      channel_id       TEXT NOT NULL,
      period_key       TEXT NOT NULL,  -- 指定期間をソートして連結したもの
      oldest_seen_id   TEXT,           -- 最後に処理したメッセージID（次はこれより前から）
      completed        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (channel_id, period_key)
    );
  `);

  migrate(db);
  return db;
}

// PRAGMA table_info の1行（必要な列だけ）
interface ColumnInfo {
  name: string;
}

// 既存 DB のスキーマ更新。CREATE TABLE IF NOT EXISTS は既存テーブルには効かないため、
// 古い形のまま残っているテーブルを個別に手当てする。
function migrate(db: Db): void {
  const cols = (db.prepare('PRAGMA table_info(scan_state)').all() as ColumnInfo[]).map((c) => c.name);

  // v1: scan_state に period_key が無い（期間ごとの独立管理より前の版）。
  // 進捗記録は作り直す。reactions は INSERT OR IGNORE なので再走査しても重複しない。
  if (cols.length > 0 && !cols.includes('period_key')) {
    db.exec(`
      DROP TABLE scan_state;
      CREATE TABLE scan_state (
        channel_id       TEXT NOT NULL,
        period_key       TEXT NOT NULL,
        oldest_seen_id   TEXT,
        completed        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel_id, period_key)
      );
    `);
    console.log('DB を更新しました（走査済みのリアクションはそのまま保持されています）');
  }

  // v2: users にロール情報が無い（EM住民フィルタより前の版）。
  // 列を足すだけ。値は次回 scan 時にギルドメンバー一覧から埋まる。
  const ucols = (db.prepare('PRAGMA table_info(users)').all() as ColumnInfo[]).map((c) => c.name);
  if (!ucols.includes('roles')) {
    db.exec(`
      ALTER TABLE users ADD COLUMN is_member INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN roles TEXT NOT NULL DEFAULT '[]';
    `);
    console.log('DB を更新しました（ロール情報の保存に対応）');
  }

  // v3: messages テーブルの新設。既存 DB は全チャンネル completed=1 のまま残っているので、
  // そのまま再実行すると全部スキップされて messages が空のままになる。投稿を拾い直すため
  // 進捗だけリセットする（reactions / messages とも INSERT OR IGNORE なので重複しない）。
  const hasMessages = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
    .get();
  const scanned = (db.prepare('SELECT COUNT(*) n FROM scan_state').get() as { n: number }).n;
  const msgCount = hasMessages
    ? (db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n
    : 0;
  if (hasMessages && scanned > 0 && msgCount === 0) {
    db.prepare('DELETE FROM scan_state').run();
    console.log(
      '投稿数の集計に対応しました。投稿を拾い直すため走査進捗をリセットします\n' +
        '（収集済みのリアクションは保持されます。次回スキャンは全チャンネルを走り直します）'
    );
  }
}
