// DEVELOPMENT ONLY: prints a `dev1` access token for local testing (curl, scripts).
// `npm run ai:token -- <athlete-id> [days]`. It refuses to run unless APEX_ENV=development, and a
// server running with APEX_ENV=production rejects every dev1 token — this can't become a way in.
// The app never uses it: it registers its own identity (POST /ai/auth/register).
import { authSecret } from './ai/config';
import { signToken } from './ai/security';

try {
  process.loadEnvFile();
} catch {
  // no .env file: use the environment as is
}

const fail = (m: string) => {
  console.error(m);
  process.exit(1);
};
if (process.env.APEX_ENV !== 'development' || process.env.NODE_ENV === 'production') fail('ai:token is for development only (APEX_ENV=development).');
const [athlete = 'dev_athlete', days = '1'] = process.argv.slice(2);
const secret = authSecret(process.env);
const ttl = Math.round(Number(days) * 86_400);
if (!secret) fail('APEX_AUTH_SECRET is not set (at least 32 characters).');
if (!(ttl > 0 && ttl <= 30 * 86_400)) fail('Days must be between 0 and 30.');
try {
  console.log(signToken(athlete, secret!, ttl, Date.now(), 'dev1'));
} catch {
  fail('Athlete id: letters, numbers, - and _ only (max 64).');
}
