// Discord OAuth2 のヘルパ。スコープは identify + guilds のみ。
// identify: ユーザー ID を得る（誰か）/ guilds: 参加ギルド一覧を得る（対象サーバーにいるか）。
// Bot 権限とは別物で、閲覧者本人の情報を読むだけ。

const AUTHORIZE = 'https://discord.com/api/oauth2/authorize';
const TOKEN = 'https://discord.com/api/oauth2/token';
const USER_GUILDS = 'https://discord.com/api/users/@me/guilds';

export interface DiscordEnv {
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  GUILD_ID: string;
}

// 認可画面の URL。state は CSRF 対策で呼び出し側が発行し、コールバックで突き合わせる。
export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify guilds',
    state,
    prompt: 'none', // 既に許可済みなら確認画面を挟まない
  });
  return `${AUTHORIZE}?${p.toString()}`;
}

// 認可コードをアクセストークンに交換する。
export async function exchangeCode(
  env: DiscordEnv,
  code: string,
  redirectUri: string
): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('no access_token in response');
  return json.access_token;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
}

interface DiscordGuild {
  id: string;
}

// アクセストークンで本人情報とギルド一覧を取り、対象サーバーのメンバーか判定する。
export async function fetchIdentityAndMembership(
  env: DiscordEnv,
  accessToken: string
): Promise<{ userId: string; username: string; isMember: boolean }> {
  const auth = { headers: { Authorization: `Bearer ${accessToken}` } };

  const [userRes, guildsRes] = await Promise.all([
    fetch('https://discord.com/api/users/@me', auth),
    fetch(USER_GUILDS, auth),
  ]);
  if (!userRes.ok) throw new Error(`fetch user failed: ${userRes.status}`);
  if (!guildsRes.ok) throw new Error(`fetch guilds failed: ${guildsRes.status}`);

  const user = (await userRes.json()) as DiscordUser;
  const guilds = (await guildsRes.json()) as DiscordGuild[];
  const isMember = guilds.some((g) => g.id === env.GUILD_ID);

  return { userId: user.id, username: user.global_name ?? user.username, isMember };
}
