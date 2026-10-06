// Who is asking, and what may be logged.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface AuthUser {
  userId: string;
}

/**
 * Token kinds, `<kind>.<payload>.<hmac>` with payload `{ sub, exp }`, signed with APEX_AUTH_SECRET:
 *  - v1:   access token issued by /ai/auth/* — 15 minutes.
 *  - dev1: issued only by the development tool (npm run ai:token); refused unless APEX_ENV=development.
 * The athlete id is always `sub` from a verified token — never anything the client sends.
 */
export type TokenKind = 'v1' | 'dev1';
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const mac = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('base64url');

export function signToken(userId: string, secret: string, ttlSec: number, now = Date.now(), kind: TokenKind = 'v1') {
  if (!USER_ID.test(userId)) throw new Error('invalid user id');
  const body = `${kind}.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(now / 1000) + ttlSec })).toString('base64url')}`;
  return `${body}.${mac(body, secret)}`;
}

export function verifyToken(token: string, secret: string, now = Date.now(), opts: { allowDev?: boolean } = {}): AuthUser | null {
  const [kind, payload, sig, ...rest] = token.split('.');
  if (!(kind === 'v1' || (kind === 'dev1' && opts.allowDev)) || !payload || !sig || rest.length) return null;
  const expected = Buffer.from(mac(`${kind}.${payload}`, secret));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof p?.sub !== 'string' || !USER_ID.test(p.sub) || typeof p.exp !== 'number' || p.exp * 1000 <= now) return null;
    return { userId: p.sub };
  } catch {
    return null;
  }
}

export function authenticate(req: Request, secret: string, now = Date.now(), opts: { allowDev?: boolean } = {}): AuthUser | null {
  const m = /^Bearer ([\w.-]{1,1024})$/.exec(req.headers.get('authorization') ?? '');
  return m ? verifyToken(m[1], secret, now, opts) : null;
}

/** Opaque per-user id for OpenAI abuse monitoring — never the raw id. */
export const safetyId = (userId: string) => createHash('sha256').update(`apex:${userId}`).digest('hex').slice(0, 32);

/**
 * The only things that can be logged: no message text, no athlete data, no action arguments, no
 * keys, tokens, headers or athlete ids. `rid` is a random per-request correlation id.
 */
export type AILogEvent = (
  | { event: 'ai.request'; ok: boolean; status: number; code?: string; model?: string; latencyMs: number; rounds?: number; tools?: number }
  | { event: 'ai.tool'; tool: string; ok: boolean; error?: string; ms: number }
  | { event: 'ai.model_error'; category: string; model: string; upstream?: { status?: number; code?: string; limitRequests?: string; limitTokens?: string } }
  | { event: 'ai.action'; op: 'propose' | 'confirm' | 'cancel'; type?: string; ok: boolean; status?: number; code?: string; latencyMs?: number; replay?: boolean }
  | { event: 'ai.auth'; op: 'register' | 'refresh' | 'revoke'; ok: boolean; status: number; code?: string; latencyMs: number }
  | { event: 'ai.config'; problem: string }
  | { event: 'ai.error'; where: string; category: string }
) & { rid?: string };

export type AILogger = (e: AILogEvent) => void;
export const consoleLogger: AILogger = (e) => console.info(JSON.stringify(e));
