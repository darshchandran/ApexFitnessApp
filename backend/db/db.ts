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

/** TLS for the pool: always certificate-verified; `ca` adds a trusted CA (e.g. Supabase's). */
export interface DbTls {
  ca?: string;
}

/** A CA given as PEM text (\\n escapes allowed, for one-line env vars) or as a path to a PEM file. */
export const loadCa = (value: string | undefined) =>
  !value ? undefined : value.includes('-----BEGIN') ? value.replace(/\\n/g, '\n') : readFileSync(value, 'utf8');

export function pgDb(connectionString: string, opts: { max?: number; tls?: DbTls; idleMs?: number } = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: opts.idleMs ?? 10_000,
    connectionTimeoutMillis: 10_000, // an unreachable database fails a request instead of hanging it
    query_timeout: 15_000,
    allowExitOnIdle: true,
    ...(opts.tls && { ssl: { rejectUnauthorized: true, ...(opts.tls.ca && { ca: opts.tls.ca }) } }),
  });
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
export const MIGRATIONS_DIR = process.env.APEX_MIGRATIONS_DIR ?? join(__dirname, '..', '..', 'supabase', 'migrations');

export interface Migration {
  name: string;
  sql: string;
}

/** The migration files in name order. (The edge build embeds this list instead of reading files.) */
export const readMigrations = (dir = MIGRATIONS_DIR): Migration[] =>
  readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));

/** Migrations not yet applied (throws if the database is unreachable). Used by the readiness check. */
export async function pendingMigrations(db: Queryable, migrations = readMigrations()): Promise<string[]> {
  const names = migrations.map((m) => m.name);
  const t = await db.query<{ ok: string | null }>("select to_regclass('public.apex_migrations')::text as ok");
  if (!t.rows[0]?.ok) return names;
  const done = new Set((await db.query<{ name: string }>('select name from public.apex_migrations')).rows.map((r) => r.name));
  return names.filter((n) => !done.has(n));
}

/**
 * Applies pending migrations in name order, each in its own transaction, recorded in
 * apex_migrations. Safe to run on every start and from several instances at once (advisory lock),
 * and safe on a database the Supabase CLI already migrated (every statement is idempotent).
 */
export async function migrate(db: Db, migrations = readMigrations()): Promise<string[]> {
  await db.query('create table if not exists public.apex_migrations (name text primary key, applied_at timestamptz not null default now())');
  const applied: string[] = [];
  for (const { name, sql } of migrations) {
    const ran = await db.tx(async (q) => {
      await q.query('select pg_advisory_xact_lock(4247001)');
      const done = await q.query('select 1 from public.apex_migrations where name = $1', [name]);
      if (done.rowCount) return false;
      await q.query(sql);
      await q.query('insert into public.apex_migrations (name) values ($1) on conflict do nothing', [name]);
      return true;
    });
    if (ran) applied.push(name);
  }
  return applied;
}
