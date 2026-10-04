// Athlete identity for the AI API.
//
// APEX has no account system yet (its data lives on the device), so each app install gets its own
// server-issued athlete identity: the smallest bridge that is safe in production. The app holds a
// refresh token in the device's secure storage and gets 15-minute access tokens with it; the
// server keeps only a hash of each refresh token, rotates it on every use, and revokes the whole
// lineage if a spent token is ever presented again (a sign it was copied). When APEX gets real
// accounts, their tokens replace registration and the identity can be linked to the account.
import { createHash, randomBytes } from 'node:crypto';
import type { Queryable, Db } from '../db/db';
import { signToken } from './security';

export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_TTL_MS = 60 * 24 * 3_600_000;
const REFRESH = /^rt_[\w-]{43}$/;

export interface TokenPair {
  athlete_id: string;
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
  refresh_expires_at: string;
}

const random = (bytes: number) => randomBytes(bytes).toString('base64url');
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

async function issue(q: Queryable, identityId: string, familyId: string, secret: string, now: Date): Promise<TokenPair> {
  const refresh = `rt_${random(32)}`;
  const refreshExpires = new Date(now.getTime() + REFRESH_TTL_MS);
  await q.query('insert into ai_refresh_tokens (token_hash, identity_id, family_id, created_at, expires_at) values ($1, $2, $3, $4, $5)', [digest(refresh), identityId, familyId, now, refreshExpires]);
  return {
    athlete_id: identityId,
    access_token: signToken(identityId, secret, ACCESS_TTL_SEC, now.getTime()),
    access_expires_at: new Date(now.getTime() + ACCESS_TTL_SEC * 1000).toISOString(),
    refresh_token: refresh,
    refresh_expires_at: refreshExpires.toISOString(),
  };
}

/** A new athlete identity for a new install. */
export function registerDevice(db: Db, secret: string, now = new Date()): Promise<TokenPair> {
  const id = `ath_${random(16)}`;
  return db.tx(async (q) => {
    await q.query('insert into ai_identities (id, created_at) values ($1, $2)', [id, now]);
    return issue(q, id, `fam_${random(12)}`, secret, now);
  });
}

/** Spend a refresh token for a new pair. Unknown, expired, revoked or reused → null (and reuse revokes the lineage). */
export function refreshSession(db: Db, secret: string, token: string, now = new Date()): Promise<TokenPair | null> {
  if (!REFRESH.test(token)) return Promise.resolve(null);
  const hash = digest(token);
  return db.tx(async (q) => {
    const spent = await q.query<{ identity_id: string; family_id: string }>(
      `update ai_refresh_tokens t set used_at = $2
       from ai_identities i
       where t.token_hash = $1 and t.used_at is null and t.revoked_at is null and t.expires_at > $2 and i.id = t.identity_id and i.revoked_at is null
       returning t.identity_id, t.family_id`,
      [hash, now],
    );
    if (spent.rowCount) return issue(q, spent.rows[0].identity_id, spent.rows[0].family_id, secret, now);
    await q.query(
      `update ai_refresh_tokens set revoked_at = $2 where revoked_at is null and family_id = (select family_id from ai_refresh_tokens where token_hash = $1 and used_at is not null)`,
      [hash, now],
    );
    return null;
  });
}

/** Sign out: the token's whole lineage stops working. Silent for unknown tokens. */
export async function revokeSession(db: Db, token: string, now = new Date()) {
  if (!REFRESH.test(token)) return;
  await db.query(`update ai_refresh_tokens set revoked_at = $2 where revoked_at is null and family_id = (select family_id from ai_refresh_tokens where token_hash = $1)`, [digest(token), now]);
}
