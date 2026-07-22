// / — トップ。セッションを検証し、対象サーバーのメンバーだけにレポートを返す。
// 未ログイン/無効セッションはログイン導線を出すだけで、データは一切出さない。
import { Pool } from '@neondatabase/serverless';
import { buildReportHtml } from '../src/build-report.js';
import { verifySession, readSessionCookie } from './_lib/session.js';

interface Env {
  DATABASE_URL: string;
  SESSION_SECRET: string;
}

function loginPage(): Response {
  const html =
    `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>EngineMaker リアクション集計</title></head>` +
    `<body style="font-family:system-ui;max-width:32rem;margin:5rem auto;padding:0 1rem;line-height:1.7;text-align:center">` +
    `<h1 style="font-size:1.4rem">EngineMaker リアクション集計</h1>` +
    `<p>このページは EngineMaker の Discord サーバーのメンバーだけが閲覧できます。</p>` +
    `<p style="margin-top:2rem">` +
    `<a href="/auth/login" style="display:inline-block;background:#5865F2;color:#fff;` +
    `text-decoration:none;padding:.7rem 1.4rem;border-radius:.5rem;font-weight:600">` +
    `Discord でログイン</a></p></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  // セッション検証。無ければログイン画面（データは出さない）。
  const token = readSessionCookie(request);
  const session = token ? await verifySession(token, env.SESSION_SECRET) : null;
  if (!session) return loginPage();

  // メンバー確認済みのセッションがある人にだけ、Neon を読んでレポートを返す。
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    const html = await buildReportHtml(pool);
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // 認証済みユーザー専用の内容。CDN/ブラウザにキャッシュさせない。
        'Cache-Control': 'private, no-store',
      },
    });
  } finally {
    await pool.end();
  }
};
