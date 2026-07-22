// /auth/callback — Discord から戻る。ここで「対象サーバーのメンバーか」を確認し、
// メンバーだけにセッション Cookie を発行する。ここを通らない限りデータは一切出さない。
import { exchangeCode, fetchIdentityAndMembership } from '../_lib/discord.js';
import { signSession, sessionCookie } from '../_lib/session.js';

interface Env {
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  GUILD_ID: string;
  SESSION_SECRET: string;
}

const SESSION_TTL_SEC = 7 * 24 * 60 * 60; // 7日

// state Cookie を読む
function readStateCookie(request: Request): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'oauth_state') return v.join('=');
  }
  return null;
}

function deny(message: string, status = 403): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>アクセスできません</title>` +
      `<div style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.7">` +
      `<h1 style="font-size:1.25rem">アクセスできません</h1><p>${message}</p>` +
      `<p><a href="/auth/login">もう一度ログイン</a></p></div>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const savedState = readStateCookie(request);

  // CSRF: 認可時に発行した state と戻りの state が一致しなければ拒否
  if (!code || !state || !savedState || state !== savedState) {
    return deny('認証リクエストが無効です（state 不一致）。', 400);
  }

  const redirectUri = `${url.origin}/auth/callback`;

  let identity;
  try {
    const accessToken = await exchangeCode(env, code, redirectUri);
    identity = await fetchIdentityAndMembership(env, accessToken);
  } catch (err) {
    return deny(`Discord 認証に失敗しました: ${(err as Error).message}`, 502);
  }

  // ここが肝: 対象サーバーのメンバーでなければデータを一切出さない
  if (!identity.isMember) {
    return deny('このページは対象の Discord サーバーのメンバーだけが閲覧できます。');
  }

  // メンバー確認 OK。署名付きセッションを発行してトップへ。
  const session = { sub: identity.userId, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC };
  const token = await signSession(session, env.SESSION_SECRET);

  const headers = new Headers({ Location: `${url.origin}/` });
  // セッション Cookie を立て、使い終わった state Cookie は消す
  headers.append('Set-Cookie', sessionCookie(token, SESSION_TTL_SEC));
  headers.append('Set-Cookie', `oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);

  return new Response(null, { status: 302, headers });
};
