// Dev helper until APEX has accounts: prints an athlete access token for the existing bearer-token
// auth, signed with APEX_AUTH_SECRET. `npm run ai:token -- <athlete-id> [days]` (default 30 days).
import { authSecret } from './ai/config';
import { signToken } from './ai/security';

try {
  process.loadEnvFile();
} catch {
  // no .env file: use the environment as is
}

const [athlete = 'athlete', days = '30'] = process.argv.slice(2);
const secret = authSecret(process.env);
const ttl = Math.round(Number(days) * 86_400);
if (!secret) {
  console.error('APEX_AUTH_SECRET is not set (at least 32 characters).');
  process.exit(1);
}
if (!(ttl > 0)) {
  console.error('Days must be a positive number.');
  process.exit(1);
}
try {
  console.log(signToken(athlete, secret, ttl));
} catch {
  console.error('Athlete id: letters, numbers, - and _ only (max 64).');
  process.exit(1);
}
