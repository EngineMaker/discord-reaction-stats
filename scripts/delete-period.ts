// 指定期間のデータを Neon から削除する。reactions / messages / scan_state の3つ。
// users は期間に紐づかないので触らない。
//
// 安全のため、引数に --commit を付けない限り「消す対象の件数を表示するだけ」で終わる（dry-run）。
//   確認: node --env-file-if-exists=.env --import tsx scripts/delete-period.ts 2026-07
//   実行: node --env-file-if-exists=.env --import tsx scripts/delete-period.ts 2026-07 --commit
import { Pool } from 'pg';

const period = process.argv[2];
const commit = process.argv.includes('--commit');

if (!period || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
  console.error('使い方: delete-period.ts YYYY-MM [--commit]');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// 消す前の件数を数える
const counts = await pool.query(
  `SELECT
     (SELECT count(*) FROM reactions  WHERE period = $1)     AS reactions,
     (SELECT count(*) FROM messages   WHERE period = $1)     AS messages,
     (SELECT count(*) FROM scan_state WHERE period_key = $1) AS scan_state`,
  [period]
);
const c = counts.rows[0];
console.log(`期間 ${period} の対象件数:`);
console.log(`  reactions:  ${c.reactions}`);
console.log(`  messages:   ${c.messages}`);
console.log(`  scan_state: ${c.scan_state}`);

if (!commit) {
  console.log('\n[dry-run] 実際に消すには末尾に --commit を付けて再実行してください。');
  await pool.end();
  process.exit(0);
}

// --commit あり: 1トランザクションでまとめて削除
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const r1 = await client.query('DELETE FROM reactions  WHERE period = $1', [period]);
  const r2 = await client.query('DELETE FROM messages   WHERE period = $1', [period]);
  const r3 = await client.query('DELETE FROM scan_state WHERE period_key = $1', [period]);
  await client.query('COMMIT');
  console.log(`\n✓ 削除しました: reactions=${r1.rowCount} messages=${r2.rowCount} scan_state=${r3.rowCount}`);
} catch (err) {
  await client.query('ROLLBACK');
  console.error('✗ 削除に失敗、ロールバックしました:', (err as Error).message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
