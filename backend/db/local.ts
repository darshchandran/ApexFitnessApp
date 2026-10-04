// Development and tests only: a real Postgres (PGlite) behind its wire-protocol server, so the
// backend talks to it through the same `pg` driver it uses in production. Never used in production.
import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

export async function startLocalPostgres(opts: { dataDir?: string; port?: number } = {}) {
  if (opts.dataDir) mkdirSync(opts.dataDir, { recursive: true });
  const db = await PGlite.create(opts.dataDir ? { dataDir: opts.dataDir } : {});
  const server = new PGLiteSocketServer({ db, port: opts.port ?? 0, host: '127.0.0.1', maxConnections: 50 });
  await server.start();
  return {
    url: `postgres://postgres@127.0.0.1:${(server as unknown as { port: number }).port}/postgres`,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}
