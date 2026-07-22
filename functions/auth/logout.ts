// /auth/logout — セッション Cookie を消してトップへ戻す。
import { clearCookie } from '../_lib/session.js';

export const onRequestGet: PagesFunction = async ({ request }) => {
  const url = new URL(request.url);
  return new Response(null, {
    status: 302,
    headers: { Location: `${url.origin}/`, 'Set-Cookie': clearCookie() },
  });
};
