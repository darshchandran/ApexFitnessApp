// The AI backend's database: Postgres (Supabase in production) through the standard `pg` driver.
// Local development and tests run the same SQL against PGlite (real Postgres in WebAssembly) behind
// its wire-protocol server — see local.ts — so there is one code path and one SQL dialect.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>;
}

export interface Db extends Queryable {
  /** Runs `fn` in one transaction on one connection; rolls back if it throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function pgDb(connectionString: string, opts: { max?: number; ssl?: boolean; idleMs?: number } = {}): Db {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10, idleTimeoutMillis: opts.idleMs ?? 10_000, allowExitOnIdle: true, ...(opts.ssl && { ssl: { rejectUnauthorized: true } }) });
  // a dropped idle connection must not crash the server; the pool replaces it
  pool.on('error', () => undefined);
  const wrap = (c: { query: pg.Pool['query'] }): Queryable => ({
    async query(sql, params) {
      const r = await c.query(sql, params as unknown[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
  });
  return {
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn(wrap(client));
        await client.query('commit');
        return out;
      } catch (e) {
        await client.query('rollback').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Migrations live in supabase/migrations (the Supabase CLI applies the same files with `supabase db push`). */
export const MIGRATIONS_DIR = join(__dirname, '..', '..', 'supabase', 'migrations');

/**
 * Applies pending migrations in name order, each in its own transaction, recorded in
 * apex_migrations. Safe to run on every start and from several instances at once (advisory lock),
 * and safe on a database the Supabase CLI already migrated (every statement is idempotent).
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.query('create table if not exists public.apex_migrations (name text primary key, applied_at timestamptz not null default now())');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const name of files) {
    const ran = await db.tx(async (q) => {
      await q.query('select pg_advisory_xact_lock(4247001)');
      const done = await q.query('select 1 from public.apex_migrations where name = $1', [name]);
      if (done.rowCount) return false;
      await q.query(readFileSync(join(dir, name), 'utf8'));
      await q.query('insert into public.apex_migrations (name) values ($1) on conflict do nothing', [name]);
      return true;
    });
    if (ran) applied.push(name);
  }
  return applied;
}
