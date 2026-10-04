// A test worker's database: a real Postgres (PGlite) on a free local port, for as long as the worker runs.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 200 });
await server.start();
console.log(`APEX_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:${server.port}/postgres`);
const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('disconnect', stop);
