// Persistent AI state in Postgres: action proposals (exactly-once confirmation) and rate-limit
// counters. Every state change is a single conditional UPDATE, so two confirms, a confirm racing a
// cancel, or a confirm racing expiry resolve in the database — on any number of server instances.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db/db';
import type { ActionDraft, ActionResult, ActionStatus, ActionType } from './actions';

export interface StoredAction extends ActionDraft {
  id: string;
  /** The authenticated athlete who was shown the proposal — the only one who can see, confirm or cancel it. */
  userId: string;
  conversationId: string;
  argumentsHash: string;
  requires_confirmation: true;
  status: ActionStatus;
  createdAt: number;
  expiresAt: number;
  result?: ActionResult;
}

/** JSON with object keys sorted — the same value always hashes the same, however it was stored (jsonb reorders keys). */
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
      : JSON.stringify(v ?? null);

export const argumentsHash = (type: ActionType, args: Record<string, unknown>) => createHash('sha256').update(canonical([type, args])).digest('hex');

interface Row {
  id: string; identity_id: string; conversation_id: string; type: ActionType; arguments: Record<string, unknown>; arguments_hash: string;
  basis: string | null; summary: string; preview: string[]; status: ActionStatus; claim_id: string | null; result: string | null;
  created_at: Date; expires_at: Date; confirmed_at: Date | null;
}

const fromRow = (r: Row): StoredAction => ({
  id: r.id, userId: r.identity_id, conversationId: r.conversation_id, type: r.type, arguments: r.arguments, argumentsHash: r.arguments_hash,
  ...(r.basis !== null && { basis: r.basis }), summary: r.summary, preview: r.preview, requires_confirmation: true, status: r.status,
  createdAt: new Date(r.created_at).getTime(), expiresAt: new Date(r.expires_at).getTime(), ...(r.result && { result: JSON.parse(r.result) as ActionResult }),
});

/** What the app sees: no athlete id, no internal fingerprints. */
export const clientAction = (a: StoredAction) => ({
  id: a.id, type: a.type, summary: a.summary, arguments: a.arguments, preview: a.preview, requires_confirmation: a.requires_confirmation,
  status: a.status, created_at: new Date(a.createdAt).toISOString(), expires_at: new Date(a.expiresAt).toISOString(),
});
export type ClientAction = ReturnType<typeof clientAction>;

export interface Claim {
  action: StoredAction;
  /** Fences the result write: only the request holding this claim may record the outcome. */
  claimId: string;
}

export class ActionStore {
  readonly ttlMs: number;
  private clock: () => number;
  /** A claim older than this with no result is treated as abandoned (the server died mid-execution). */
  private leaseMs: number;
  private keepMs: number;
  /** How long a confirm waits for another request's execution before answering "in progress". */
  private settleMs: number;

  constructor(private db: Db, opts: { ttlMs?: number; clock?: () => number; leaseMs?: number; keepMs?: number; settleMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.clock = opts.clock ?? Date.now;
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.keepMs = opts.keepMs ?? 7 * 24 * 3_600_000;
    this.settleMs = opts.settleMs ?? 10_000;
  }

  private now = () => new Date(this.clock());

  async create(draft: ActionDraft, userId: string, conversationId: string): Promise<StoredAction> {
    const now = this.now();
    // old actions (and the records in their results) are not kept longer than needed for retries
    if (Math.random() < 0.05) await this.db.query('delete from ai_actions where created_at < $1', [new Date(now.getTime() - this.keepMs)]);
    const r = await this.db.query<Row>(
      `insert into ai_actions (id, identity_id, conversation_id, type, arguments, arguments_hash, basis, summary, preview, status, created_at, expires_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $10) returning *`,
      [randomUUID(), userId, conversationId, draft.type, JSON.stringify(draft.arguments), argumentsHash(draft.type, draft.arguments), draft.basis ?? null,
        draft.summary, JSON.stringify(draft.preview), now, new Date(now.getTime() + this.ttlMs)],
    );
    return fromRow(r.rows[0]);
  }

  /** The athlete's own action, or undefined — another athlete's id is indistinguishable from a missing one. */
  async get(id: string, userId: string): Promise<StoredAction | undefined> {
    const now = this.now();
    // a pending action past its expiry is expired for good, whoever looks first
    await this.db.query(`update ai_actions set status = 'expired', updated_at = $3 where id = $1 and identity_id = $2 and status = 'pending' and expires_at <= $3`, [id, userId, now]);
    const r = await this.db.query<Row>('select * from ai_actions where id = $1 and identity_id = $2', [id, userId]);
    return r.rows[0] && fromRow(r.rows[0]);
  }

  /** pending → cancelled, atomically. Returns the action as it now stands. */
  async cancel(id: string, userId: string): Promise<StoredAction | undefined> {
    await this.db.query(
      `update ai_actions set status = 'cancelled', cancelled_at = $3, updated_at = $3 where id = $1 and identity_id = $2 and status = 'pending' and expires_at > $3`,
      [id, userId, this.now()],
    );
    return this.get(id, userId);
  }

  /** Marks an action failed for good (e.g. its type is no longer allowed). */
  async fail(id: string, userId: string, result: ActionResult) {
    const now = this.now();
    await this.db.query(`update ai_actions set status = 'failed', result = $3, executed_at = $4, updated_at = $4 where id = $1 and identity_id = $2 and status = 'pending'`, [id, userId, JSON.stringify(result), now]);
  }

  /**
   * Claims the right to execute: pending (and not expired) → confirmed. Exactly one request can win.
   * A claim abandoned by a crashed server can be taken over after the lease; its result was never
   * recorded or returned, so nothing ran twice.
   */
  async claim(id: string, userId: string): Promise<Claim | undefined> {
    const now = this.now();
    const claimId = randomBytes(12).toString('hex');
    const r = await this.db.query<Row>(
      `update ai_actions set status = 'confirmed', claim_id = $3, confirmed_at = $4, updated_at = $4
       where id = $1 and identity_id = $2
         and ((status = 'pending' and expires_at > $4) or (status = 'confirmed' and result is null and confirmed_at < $5))
       returning *`,
      [id, userId, claimId, now, new Date(now.getTime() - this.leaseMs)],
    );
    return r.rows[0] ? { action: fromRow(r.rows[0]), claimId } : undefined;
  }

  /** Records the outcome if this request still holds the claim; returns whatever outcome was recorded. */
  async finish(claim: Claim, result: ActionResult): Promise<StoredAction> {
    const now = this.now();
    await this.db.query(
      `update ai_actions set status = $3, result = $4, executed_at = $5, updated_at = $5, claim_id = null where id = $1 and claim_id = $2 and status = 'confirmed'`,
      [claim.action.id, claim.claimId, result.success ? 'executed' : 'failed', JSON.stringify(result), now],
    );
    return (await this.get(claim.action.id, claim.action.userId))!;
  }

  /** Waits for another request's execution to be recorded (or abandoned). */
  async settled(id: string, userId: string, timeoutMs = this.settleMs): Promise<StoredAction | undefined> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const a = await this.get(id, userId);
      if (!a || a.status !== 'confirmed' || Date.now() >= until) return a;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/**
 * Fixed-window counters shared by every server instance. Keys are chosen by the server from verified
 * identity (or the observed client address) — never from anything the client sends.
 */
export class RateLimits {
  constructor(private db: Db, private namespace = '') {}

  /** 0 = allowed; otherwise ms until the window resets. */
  async take(key: string, max: number, windowMs: number, nowMs = Date.now()): Promise<number> {
    const start = Math.floor(nowMs / windowMs) * windowMs;
    const r = await this.db.query<{ count: number }>(
      `insert into ai_rate_limits (key, window_start, count) values ($1, $2, 1)
       on conflict (key, window_start) do update set count = ai_rate_limits.count + 1 returning count`,
      [`${this.namespace}${key}`, new Date(start)],
    );
    if (Math.random() < 0.01) await this.db.query('delete from ai_rate_limits where window_start < $1', [new Date(nowMs - 24 * 3_600_000)]);
    return r.rows[0].count > max ? start + windowMs - nowMs : 0;
  }
}
