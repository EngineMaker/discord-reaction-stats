import { Pool } from 'pg';

export type Db = Pool;

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

// Neon(Postgres) への接続プールを作り、スキーマを用意して返す。
// SQLite 版と違い pg は非同期なので、呼び出し側は await する。
// スキーマは新規作成前提（SQLite 版のような v1/v2/v3 マイグレーション履歴は持たない。
// 既存 SQLite データは一回限りの移行スクリプトで運び込む）。
//
// 設計方針は SQLite 版から引き継ぐ:
//  - is_bot / is_member は BOOLEAN ではなく INTEGER のまま（既存ロジックが = 1 比較に依存）
//  - roles は JSON 配列の文字列（TEXT）。ロール名で絞るので ID ではなく名前で持つ
//  - reactions / messages は「同じ期間を何度走査しても重複しない」主キー設計を維持
export async function openDb(connectionString: string): Promise<Db> {
  const pool = new Pool({ connectionString });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reactions (
      message_id   TEXT NOT NULL,
      channel_id   TEXT NOT NULL,
      emoji_key    TEXT NOT NULL,
      emoji_label  TEXT NOT NULL,
      emoji_url    TEXT,
      giver_id     TEXT NOT NULL,
      receiver_id  TEXT NOT NULL,
      message_ts   BIGINT NOT NULL,
      period       TEXT NOT NULL,
      PRIMARY KEY (message_id, emoji_key, giver_id)
    );
    CREATE INDEX IF NOT EXISTS idx_period ON reactions(period);

    CREATE TABLE IF NOT EXISTS users (
      user_id      TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      avatar_url   TEXT,
      is_bot       INTEGER NOT NULL DEFAULT 0,
      is_member    INTEGER NOT NULL DEFAULT 0,
      roles        TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS messages (
      message_id  TEXT PRIMARY KEY,
      channel_id  TEXT NOT NULL,
      author_id   TEXT NOT NULL,
      message_ts  BIGINT NOT NULL,
      period      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_period ON messages(period);

    CREATE TABLE IF NOT EXISTS scan_state (
      channel_id       TEXT NOT NULL,
      period_key       TEXT NOT NULL,
      oldest_seen_id   TEXT,
      completed        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (channel_id, period_key)
    );
  `);
  return pool;
}
