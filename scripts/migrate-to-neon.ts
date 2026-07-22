// SQLite (data.sqlite) の全データを Neon(Postgres) に一回限り移行する。
// 冪等: ON CONFLICT DO NOTHING なので複数回流しても重複しない。
// 使い方: node --env-file-if-exists=.env --import tsx src/migrate-to-neon.ts
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL が未設定です (.env を確認)');
  process.exit(1);
}

const sqlitePath = new URL('../data.sqlite', import.meta.url).pathname;
const sqlite = new Database(sqlitePath, { readonly: true });
const pg = await openDb(url);

// バッチ INSERT。件数が多いので1行ずつではなく複数値をまとめて送る。
async function copy(
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
  conflictCols: string
): Promise<number> {
  if (rows.length === 0) return 0;
  const BATCH = 500; // 1文あたりの行数。パラメータ上限(65535)に対し余裕を持たせる
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const values: unknown[] = [];
    const tuples = slice.map((row, r) => {
      const ph = columns.map((_, c) => `$${r * columns.length + c + 1}`);
      for (const col of columns) values.push(row[col]);
      return `(${ph.join(', ')})`;
    });
    const sql =
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')} ` +
      `ON CONFLICT (${conflictCols}) DO NOTHING`;
    const res = await pg.query(sql, values);
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

const users = sqlite.prepare('SELECT * FROM users').all() as Record<string, unknown>[];
const reactions = sqlite.prepare('SELECT * FROM reactions').all() as Record<string, unknown>[];
const messages = sqlite.prepare('SELECT * FROM messages').all() as Record<string, unknown>[];
const scanState = sqlite.prepare('SELECT * FROM scan_state').all() as Record<string, unknown>[];

console.log(`SQLite: users=${users.length} reactions=${reactions.length} messages=${messages.length} scan_state=${scanState.length}`);

const nUsers = await copy('users', ['user_id', 'display_name', 'avatar_url', 'is_bot', 'is_member', 'roles'], users, 'user_id');
const nReactions = await copy('reactions', ['message_id', 'channel_id', 'emoji_key', 'emoji_label', 'emoji_url', 'giver_id', 'receiver_id', 'message_ts', 'period'], reactions, 'message_id, emoji_key, giver_id');
const nMessages = await copy('messages', ['message_id', 'channel_id', 'author_id', 'message_ts', 'period'], messages, 'message_id');
const nScan = await copy('scan_state', ['channel_id', 'period_key', 'oldest_seen_id', 'completed'], scanState, 'channel_id, period_key');

console.log(`Neon へ投入: users=${nUsers} reactions=${nReactions} messages=${nMessages} scan_state=${nScan}`);

// 検証: 両者の件数が一致するか
const counts = await pg.query(`
  SELECT
    (SELECT COUNT(*) FROM users)      AS users,
    (SELECT COUNT(*) FROM reactions)  AS reactions,
    (SELECT COUNT(*) FROM messages)   AS messages,
    (SELECT COUNT(*) FROM scan_state) AS scan_state
`);
const c = counts.rows[0];
console.log(`Neon 合計:   users=${c.users} reactions=${c.reactions} messages=${c.messages} scan_state=${c.scan_state}`);
const okUsers = Number(c.users) === users.length;
const okReactions = Number(c.reactions) === reactions.length;
const okMessages = Number(c.messages) === messages.length;
console.log(okUsers && okReactions && okMessages ? '✓ 件数一致' : '✗ 件数不一致 — 要調査');

sqlite.close();
await pg.end();
