// スキャンの進捗を Neon で確認する。CI のログ表示が滞っても実数はここで分かる。
// GitHub Actions の Web ログは表示が固まることがあるが、DB の数字が真実。
// 使い方: node --env-file-if-exists=.env --import tsx scripts/progress.ts [YYYY-MM]
//   期間を省略すると全期間の合計を出す。
import { Pool } from 'pg';

const period = process.argv[2]; // 例: 2026-07。省略時は全期間

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
if (period) {
  const r = await pool.query(
    `SELECT
       (SELECT count(*) FROM reactions  WHERE period = $1) AS rx,
       (SELECT count(*) FROM messages   WHERE period = $1) AS msg,
       (SELECT count(*) FROM scan_state WHERE period_key = $1 AND completed = 1) AS done_ch,
       (SELECT count(*) FROM scan_state WHERE period_key = $1) AS seen_ch`,
    [period]
  );
  console.log(new Date().toISOString(), `[${period}]`, r.rows[0]);
} else {
  const r = await pool.query(`
    SELECT
      (SELECT count(*) FROM reactions)  AS rx,
      (SELECT count(*) FROM messages)   AS msg,
      (SELECT count(*) FROM users)      AS users,
      (SELECT count(*) FROM scan_state WHERE completed = 1) AS done_ch
  `);
  console.log(new Date().toISOString(), '[全期間]', r.rows[0]);
}
await pool.end();
