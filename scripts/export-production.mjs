// Production web + Android export pointed at the production APEX AI backend, then a bundle scan.
// EXPO_PUBLIC_APEX_AI_URL=https://ai.example.com npm run export:production
// The address is public (it ends up in the app); no secret is read or bundled here.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const url = process.env.EXPO_PUBLIC_APEX_AI_URL?.trim().replace(/\/+$/, '');
const fail = (m) => {
  console.error(m);
  process.exit(1);
};
if (!url || !/^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(url)) fail('Set EXPO_PUBLIC_APEX_AI_URL to the production AI backend, e.g. https://<project>.supabase.co/functions/v1/apex-ai (https, no query).');
if (/^https:\/\/(localhost|127\.|10\.|192\.168\.|\[::1\])/i.test(url)) fail('EXPO_PUBLIC_APEX_AI_URL points at a local address — not a production backend.');
for (const secret of ['OPENAI_API_KEY', 'APEX_AUTH_SECRET', 'DATABASE_URL']) {
  if (process.env[`EXPO_PUBLIC_${secret}`]) fail(`EXPO_PUBLIC_${secret} is set — it would be bundled into the app. Remove it.`);
}

const run = (cmd, args, shell = false) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell, env: { ...process.env, EXPO_PUBLIC_APEX_AI_URL: url, NODE_ENV: 'production', EXPO_NO_TELEMETRY: '1' } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
rmSync('dist', { recursive: true, force: true });
run('npx', ['expo', 'export', '-p', 'web', '-p', 'android'], process.platform === 'win32'); // npx is a .cmd on Windows
run(process.execPath, ['scripts/scan-bundle.mjs', 'dist', '--expect', url]);
console.log(`Production client exported to dist/ for ${url}`);
