// `npm run ai:migrate` — applies supabase/migrations to DATABASE_URL (deploy step; the server also
// applies them on start). Idempotent. On Supabase, `supabase db push` applies the same files.
import { loadCa, migrate, pgDb } from './db/db';

async function main() {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file
  }
  const url = process.env.DATABASE_URL;
  if (!url || !/^postgres(ql)?:\/\//.test(url)) throw new Error('DATABASE_URL must be a postgres:// connection string');
  const db = pgDb(url, { max: 1, tls: process.env.DATABASE_SSL === 'require' ? { ca: loadCa(process.env.DATABASE_CA_CERT) } : undefined });
  try {
    const applied = await migrate(db);
    console.info(JSON.stringify({ event: 'ai.migrate', applied }));
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ event: 'ai.migrate_failed', message: e instanceof Error && e.message.startsWith('DATABASE_URL') ? e.message : 'migration failed' }));
  process.exit(1);
});
