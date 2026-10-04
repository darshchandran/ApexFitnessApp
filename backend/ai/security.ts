// Who is asking, how often, and what may be logged.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface AuthUser {
  userId: string;
}

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const mac = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('base64url');

/**
 * Signed bearer token `v1.<payload>.<hmac>`, payload `{ sub, exp }`. APEX has no accounts yet;
 * whatever issues accounts later signs these with APEX_AUTH_SECRET.
 * ponytail: HMAC tokens without revocation — move to the account provider's tokens when accounts exist.
 */
export function signToken(userId: string, secret: string, ttlSec: number, now = Date.now()) {
  if (!USER_ID.test(userId)) throw new Error('invalid user id');
  const body = `v1.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(now / 1000) + ttlSec })).toString('base64url')}`;
  return `${body}.${mac(body, secret)}`;
}

export function verifyToken(token: string, secret: string, now = Date.now()): AuthUser | null {
  const [v, payload, sig, ...rest] = token.split('.');
  if (v !== 'v1' || !payload || !sig || rest.length) return null;
  const expected = Buffer.from(mac(`${v}.${payload}`, secret));
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

export function authenticate(req: Request, secret: string, now = Date.now()): AuthUser | null {
  const m = /^Bearer ([\w.-]{1,1024})$/.exec(req.headers.get('authorization') ?? '');
  return m ? verifyToken(m[1], secret, now) : null;
}

/** Opaque per-user id for OpenAI abuse monitoring — never the raw id. */
export const safetyId = (userId: string) => createHash('sha256').update(`apex:${userId}`).digest('hex').slice(0, 32);

/** Fixed window per user. ponytail: in-process memory — a shared store (e.g. Redis) once there is more than one server. */
export class RateLimiter {
  private hits = new Map<string, { start: number; n: number }>();
  constructor(private max: number, private windowMs: number) {}

  /** 0 = allowed; otherwise ms until the window resets. */
  take(userId: string, now = Date.now()): number {
    const w = this.hits.get(userId);
    if (!w || now - w.start >= this.windowMs) {
      if (this.hits.size >= 10_000) this.hits.clear(); // bounded memory
      this.hits.set(userId, { start: now, n: 1 });
      return 0;
    }
    if (w.n >= this.max) return this.windowMs - (now - w.start);
    w.n++;
    return 0;
  }
}

/** The only things that can be logged: no message text, no athlete data, no keys, no headers, no user ids. */
export type AILogEvent =
  | { event: 'ai.request'; ok: boolean; status: number; code?: string; model?: string; latencyMs: number; rounds?: number; tools?: number }
  | { event: 'ai.tool'; tool: string; ok: boolean; error?: string; ms: number }
  | { event: 'ai.model_error'; category: string; model: string }
  | { event: 'ai.config'; problem: string };

export type AILogger = (e: AILogEvent) => void;
export const consoleLogger: AILogger = (e) => console.info(JSON.stringify(e));
