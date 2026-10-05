// APEX AI backend. `npm run ai:server` — reads .env; secrets stay in this process.
// APEX_ENV must say development or production; production refuses to start without real
// credentials, a database, explicit CORS and an explicit registration policy.
import OpenAI from 'openai';
import { loadCa, migrate, pgDb, type Db } from './db/db';
import { loadServerConfig } from './ai/config';
import { createDeps } from './ai/handler';
import type { ResponsesClient } from './ai/service';
import { createAIServer, startupFailure } from './http';

async function main() {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file: use the environment as is
  }
  const config = loadServerConfig(process.env);

  let db: Db;
  if (config.databaseUrl) {
    db = pgDb(config.databaseUrl, { tls: config.databaseSsl === 'require' ? { ca: loadCa(config.databaseCaCert) } : undefined });
  } else {
    // development only (production requires DATABASE_URL): a local Postgres kept in .data/
    const { startLocalPostgres } = await import('./db/local.js');
    const local = await startLocalPostgres({ dataDir: '.data/ai-db' });
    db = pgDb(local.url, { max: 5 });
  }
  // migrations run before the server listens; if they fail, the process exits and never serves an old schema
  const applied = await migrate(db);

  const deps = createDeps(config, db, (apiKey) => new OpenAI({ apiKey, maxRetries: 1 }) as unknown as ResponsesClient);
  const port = Number(process.env.PORT) || 8787;
  const host = process.env.HOST || '127.0.0.1';
  createAIServer(deps, { corsOrigins: config.corsOrigins, trustProxy: config.trustProxy }).listen(port, host, () =>
    console.info(JSON.stringify({ event: 'ai.server', env: config.env, host, port, ai: !!deps.ai, migrations: applied.length, registration: config.registration, cors: config.corsOrigins.length })));
}

main().catch((e) => {
  console.error(JSON.stringify(startupFailure(e)));
  process.exit(1);
});
