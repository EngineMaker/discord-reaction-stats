// CLI: Neon を読んでレポート HTML をファイルに書き出す。
// HTML 生成本体は build-report.ts に切り出してあり、Cloudflare Pages Functions と共有する。
import { writeFileSync } from 'node:fs';
import { openDb } from './db.js';
import { buildReportHtml } from './build-report.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL が未設定です (.env を確認)');
  process.exit(1);
}

const db = await openDb(url);
const includeBots = process.argv.includes('--include-bots');

// データがあるかだけ先に確認（空なら scan 未実行を知らせて終わる）
const { rows } = await db.query('SELECT 1 FROM reactions LIMIT 1');
if (rows.length === 0) {
  console.error('データがありません。先に scan を実行してください。');
  await db.end();
  process.exit(1);
}

const html = await buildReportHtml(db, includeBots);

const out = new URL('../report.html', import.meta.url).pathname;
writeFileSync(out, html);
console.log(`出力: ${out}`);

// プールを閉じないと接続が残ってプロセスが終わらない
await db.end();
