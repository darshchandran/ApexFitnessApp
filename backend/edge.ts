// APEX AI on Supabase Edge Functions (Deno): the same routes, checks and database code as
// server.ts. `npm run ai:build:edge` bundles it into one file deployed as the `apex-ai` function.
//
// Configuration: Supabase provides SUPABASE_DB_URL. OPENAI_API_KEY (and optionally APEX_AI_MODEL)
// are Edge Function secrets. The token-signing secret is `apex_auth_secret` in Supabase Vault,
// generated inside the database (see DEPLOY.md) so no person or tool ever handles it.
import OpenAI from 'openai';
import { ConfigError, loadServerConfig } from './ai/config';
import { createDeps, type ChatDeps } from './ai/handler';
import { ERRORS } from './ai/schemas';
import type { ResponsesClient } from './ai/service';
import { migrate, pendingMigrations, pgDb, type Migration } from './db/db';
import { serve, startupFailure } from './http';

declare const Deno: { env: { toObject(): Record<string, string> }; serve(handler: (req: Request) => Promise<Response>): unknown };
/** supabase/migrations, embedded by the build (an edge function has no files to read). */
declare const __APEX_MIGRATIONS__: Migration[];

/** Production, always; the settings that aren't secrets have defaults the function's secrets may override. */
export function edgeEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    APEX_AI_MODEL: 'gpt-5-mini',
    APEX_AI_CORS_ORIGINS: 'none',
    APEX_AI_REGISTRATION: 'open',
    ...env,
    APEX_ENV: 'production',
    DATABASE_SSL: 'require',
    // TLS is set explicitly (certificate verified); an sslmode in the URL would override that
    DATABASE_URL: (env.DATABASE_URL ?? env.SUPABASE_DB_URL)?.replace(/([?&])sslmode=[^&]*(&|$)/, (_, a: string, b: string) => (b ? a : '')),
  };
}

/** The caller's address as Supabase's edge proxy reports it (it overwrites what the client sends). */
export const edgeClientIp = (h: Headers) => h.get('cf-connecting-ip')?.trim() || h.get('x-forwarded-for')?.split(',').at(-1)?.trim() || 'unknown';

/** Requests arrive as /apex-ai/<route>; the API's routes start at /. */
export const edgePath = (pathname: string) => pathname.replace(/^(\/functions\/v1)?\/apex-ai(?=\/|$)/, '') || '/';

async function start(): Promise<{ deps: ChatDeps; cors: string[] }> {
  const env = edgeEnv(Deno.env.toObject());
  if (!env.DATABASE_URL) throw new ConfigError(['SUPABASE_DB_URL is not available']);
  const db = pgDb(env.DATABASE_URL, { max: 3, tls: {} });
  const vault = env.APEX_AUTH_SECRET
    ? undefined
    : (await db.query<{ s: string }>("select decrypted_secret as s from vault.decrypted_secrets where name = 'apex_auth_secret'")).rows[0]?.s;
  const config = loadServerConfig({ ...env, APEX_AUTH_SECRET: env.APEX_AUTH_SECRET ?? vault });
  const applied = (await pendingMigrations(db, __APEX_MIGRATIONS__)).length ? await migrate(db, __APEX_MIGRATIONS__) : [];
  const tls = (await db.query<{ v: string | null }>('select version as v from pg_stat_ssl where pid = pg_backend_pid()')).rows[0]?.v ?? 'none';
  const deps: ChatDeps = { ...createDeps(config, db, (apiKey) => new OpenAI({ apiKey, maxRetries: 1 }) as unknown as ResponsesClient), migrations: __APEX_MIGRATIONS__ };
  console.info(JSON.stringify({ event: 'ai.server', env: config.env, runtime: 'supabase-edge', ai: !!deps.ai, migrations: applied.length, db_tls: tls, registration: config.registration, cors: config.corsOrigins.length }));
  return { deps, cors: config.corsOrigins };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

let ready: Promise<{ deps: ChatDeps; cors: string[] }> | undefined;
if (typeof Deno !== 'undefined') {
  Deno.serve(async (req) => {
    const url = new URL(req.url);
    url.pathname = edgePath(url.pathname);
    if (req.method === 'GET' && url.pathname === '/healthz') return json(200, { status: 'ok' }); // liveness needs no database
    // set up once per instance; a failed start (database down, configuration) is retried by the next request
    ready ??= start().catch((e) => {
      ready = undefined;
      console.error(JSON.stringify(startupFailure(e)));
      throw e;
    });
    let app: Awaited<typeof ready>;
    try {
      app = await ready;
    } catch {
      return url.pathname === '/readyz'
        ? json(503, { status: 'not_ready', checks: { startup: 'failed' } })
        : json(503, { error: { code: 'ai_unavailable', message: ERRORS.ai_unavailable.message } });
    }
    return serve(new Request(url, req), app.deps, { corsOrigins: app.cors, clientIp: edgeClientIp(req.headers) });
  });
}
