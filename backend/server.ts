// APEX AI backend. `npm run ai:server` — reads .env; secrets stay in this process.
// APEX_ENV must say development or production; production refuses to start without real
// credentials, a database, explicit CORS and an explicit registration policy.
import OpenAI from 'openai';
import { migrate, pgDb, type Db } from './db/db';
import { ConfigError, loadServerConfig } from './ai/config';
import { createDeps } from './ai/handler';
import type { ResponsesClient } from './ai/service';
import { createAIServer } from './http';

async function main() {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file: use the environment as is
  }
  const config = loadServerConfig(process.env);

  let db: Db;
  if (config.databaseUrl) {
    db = pgDb(config.databaseUrl, { ssl: process.env.DATABASE_SSL === 'require' });
  } else {
    // development only (production requires DATABASE_URL): a local Postgres kept in .data/
    const { startLocalPostgres } = await import('./db/local');
    const local = await startLocalPostgres({ dataDir: '.data/ai-db' });
    db = pgDb(local.url, { max: 5 });
  }
  const applied = await migrate(db);

  const deps = createDeps(config, db, (apiKey) => new OpenAI({ apiKey, maxRetries: 1 }) as unknown as ResponsesClient);
  const port = Number(process.env.PORT) || 8787;
  const host = process.env.HOST || '127.0.0.1';
  createAIServer(deps, { corsOrigins: config.corsOrigins, trustProxy: config.trustProxy }).listen(port, host, () =>
    console.info(JSON.stringify({ event: 'ai.server', env: config.env, host, port, ai: !!deps.ai, migrations: applied.length, registration: config.registration, cors: config.corsOrigins.length })));
}

/** An error message with connection strings and anything that looks like a key masked. */
const scrub = (m: unknown) => String(m ?? '').replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '<url>').replace(/\b(sk|rt|v1|dev1)[-_.][\w.-]{8,}/g, '<secret>').slice(0, 300);

main().catch((e) => {
  // configuration problems name variables, never values; other failures are reported scrubbed
  console.error(JSON.stringify(e instanceof ConfigError ? { event: 'ai.config', problems: e.problems } : { event: 'ai.startup_failed', category: e?.name ?? 'error', code: e?.code, message: scrub(e?.message) }));
  process.exit(1);
});
