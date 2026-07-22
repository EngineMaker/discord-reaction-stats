// /auth/login — Discord の認可画面へリダイレクトする。
// CSRF 対策の state をランダム生成し、短命 Cookie に入れておく。コールバックで突き合わせる。
import { authorizeUrl } from '../_lib/discord.js';

interface Env {
  DISCORD_CLIENT_ID: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/auth/callback`;

  // state: 予測不能なランダム値。認可URLとCookieの両方に載せ、戻りで一致を確認する。
  const state = crypto.randomUUID();
  const authUrl = authorizeUrl(env.DISCORD_CLIENT_ID, redirectUri, state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl,
      // state Cookie は短命 (10分)。HttpOnly + SameSite=Lax。
      'Set-Cookie': `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    },
  });
};
