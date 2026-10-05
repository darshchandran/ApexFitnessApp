// Scans an exported client (dist/) for anything that must never ship in the app: server secrets,
// OpenAI endpoints, database or token-signing code, development tooling, local addresses.
// `node scripts/scan-bundle.mjs [dist] [--expect https://ai.example.com]` — exits 1 on any finding.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const at = args.indexOf('--expect');
const expect = at >= 0 ? args[at + 1] : undefined;
const dir = args.find((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1)) ?? 'dist';

const FORBIDDEN = [
  ['OpenAI key variable', /OPENAI_API_KEY/],
  ['OpenAI key', /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/],
  ['OpenAI endpoint', /api\.openai\.com|\/v1\/responses\b/],
  ['auth secret variable', /APEX_AUTH_SECRET/],
  ['database variable', /DATABASE_URL|DATABASE_CA_CERT/],
  ['database connection string', /postgres(ql)?:\/\/[^\s"'`]+/],
  ['database driver', /pg-pool|pg-protocol|pg-connection-string|electric-sql/],
  ['token signing', /signToken|registerDevice|createHmac/],
  ['development token tool', /ai:token|\bdev1\.[A-Za-z0-9_-]{8,}/],
  ['backend code', /backend\/ai\/|backend\/db\//],
  ['local AI server address', /(localhost|127\.0\.0\.1|10\.0\.2\.2):8787/],
];

const files = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? files(p) : /\.(js|hbc|html|json|map|bundle)$/.test(f) ? [p] : [];
});

const all = files(dir);
const findings = [];
let sawExpected = false;
for (const f of all) {
  const text = readFileSync(f).toString('latin1');
  for (const [what, re] of FORBIDDEN) if (re.test(text)) findings.push(`${what}: ${relative(dir, f)}`);
  if (expect && text.includes(expect)) sawExpected = true;
}
if (expect && !sawExpected) findings.push(`the production AI address ${expect} is not in the bundle (build not pointed at it?)`);

console.log(JSON.stringify({ event: 'bundle.scan', files: all.length, findings, ...(expect && { aiUrlInBundle: sawExpected }) }, null, 1));
process.exit(findings.length ? 1 : 0);
