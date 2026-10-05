// Builds the production backend into build/server: compiled JavaScript, the migrations, and a
// package.json with only the runtime dependencies (openai, pg) pinned to the tested versions.
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const out = join(root, 'build', 'server');
const version = (pkg) => JSON.parse(readFileSync(join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version;

rmSync(out, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'backend', 'tsconfig.build.json')], { stdio: 'inherit' });
cpSync(join(root, 'supabase', 'migrations'), join(out, 'supabase', 'migrations'), { recursive: true });
writeFileSync(join(out, 'package.json'), `${JSON.stringify({
  name: 'apex-ai-backend',
  private: true,
  type: 'commonjs',
  engines: { node: '>=22' },
  scripts: { start: 'node backend/server.js', migrate: 'node backend/migrate.js' },
  dependencies: { openai: version('openai'), pg: version('pg') },
}, null, 2)}\n`);
console.log(`built ${out}`);
