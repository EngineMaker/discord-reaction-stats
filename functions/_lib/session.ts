// 署名付きセッション。Cloudflare Workers ランタイムには Web 標準の crypto.subtle が
// あるので、外部ライブラリなしで HMAC-SHA256 の署名・検証ができる。
//
// Cookie の中身は `base64url(payload).base64url(署名)` の形。payload は
// { sub: DiscordユーザーID, exp: 失効時刻(epoch秒) } の JSON。
// 署名鍵 (SESSION_SECRET) を知らないと有効な Cookie を作れないので、改ざんを防げる。

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface Session {
  sub: string; // Discord ユーザー ID
  exp: number; // 失効時刻 (epoch 秒)
}

const b64urlEncode = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const b64urlDecode = (str: string): Uint8Array<ArrayBuffer> => {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

// セッションを署名付き文字列にする。TTL はデフォルト7日。
export async function signSession(session: Session, secret: string): Promise<string> {
  const payload = b64urlEncode(enc.encode(JSON.stringify(session)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

// 署名付き文字列を検証してセッションを取り出す。改ざん・失効・不正形式は null。
export async function verifySession(token: string, secret: string): Promise<Session | null> {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const key = await hmacKey(secret);
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify('HMAC', key, b64urlDecode(sig), enc.encode(payload));
  } catch {
    return null;
  }
  if (!valid) return null;

  try {
    const session = JSON.parse(dec.decode(b64urlDecode(payload))) as Session;
    if (typeof session.exp !== 'number' || session.exp < Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

const COOKIE_NAME = 'em_session';

// Set-Cookie ヘッダ値を作る。HttpOnly + Secure + SameSite=Lax でセッション固定/CSRF に備える。
export function sessionCookie(token: string, maxAgeSec: number): string {
  return (
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`
  );
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// Cookie ヘッダから em_session の値を取り出す。
export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return v.join('=');
  }
  return null;
}
