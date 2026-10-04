// AI configuration, read from the server environment only. The OpenAI key never reaches the app
// bundle (no EXPO_PUBLIC_ variable), never leaves this process except to OpenAI, never gets logged.

export type ModelMode = 'fast' | 'default' | 'deep';

export interface AILimits {
  maxMessageChars: number;
  /** The request carries the athlete's local data (APEX is local-first), so allow a few MB. */
  maxBodyBytes: number;
  /** Model responses that may ask for tools before the request is stopped. */
  maxToolRounds: number;
  maxToolCallsPerRound: number;
  timeoutMs: number;
  maxOutputTokens: number;
  requestsPerWindow: number;
  windowMs: number;
  /** Conversation turns (user + assistant) kept for continuity. */
  historyTurns: number;
  /** Confirm/cancel per athlete (they don't call the model). */
  actionRequestsPerWindow: number;
  /** Device registrations: per client address, and for the whole service, per hour. */
  registrationsPerIpPerHour: number;
  registrationsPerHour: number;
  /** Token refreshes per client address per window. */
  refreshesPerWindow: number;
}

export const DEFAULT_LIMITS: AILimits = {
  maxMessageChars: 2000,
  maxBodyBytes: 4_000_000,
  maxToolRounds: 5,
  maxToolCallsPerRound: 6,
  timeoutMs: 30_000,
  maxOutputTokens: 2000,
  requestsPerWindow: 20,
  windowMs: 10 * 60_000,
  historyTurns: 8,
  actionRequestsPerWindow: 60,
  registrationsPerIpPerHour: 10,
  registrationsPerHour: 500,
  refreshesPerWindow: 120,
};

export interface AIConfig {
  apiKey: string;
  models: Record<ModelMode, string>;
  limits: AILimits;
}

export class AIConfigError extends Error {
  name = 'AIConfigError';
}

const MODEL_NAME = /^[A-Za-z0-9][\w.:-]{0,99}$/;
type Env = Record<string, string | undefined>;

/** Throws AIConfigError naming the variable — never its value. */
export function loadAIConfig(env: Env = process.env, limits: AILimits = DEFAULT_LIMITS): AIConfig {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new AIConfigError('OPENAI_API_KEY is not set');
  const model = (name: string, fallback?: string) => {
    const v = env[name]?.trim() || fallback;
    if (!v) throw new AIConfigError(`${name} is not set`);
    if (!MODEL_NAME.test(v)) throw new AIConfigError(`${name} is not a valid model name`);
    return v;
  };
  const base = model('APEX_AI_MODEL');
  return { apiKey, models: { default: base, fast: model('APEX_FAST_MODEL', base), deep: model('APEX_DEEP_MODEL', base) }, limits };
}

/** Bearer-token secret. Missing or short → every request is refused (fail closed). */
export const authSecret = (env: Env = process.env) => {
  const s = env.APEX_AUTH_SECRET;
  return s && s.length >= 32 ? s : undefined;
};

// ---------- the server's whole configuration, with production guards ----------

export type Environment = 'development' | 'production';

export interface ServerConfig {
  env: Environment;
  authSecret: string;
  /** Required in production. In development, unset = the built-in local Postgres. */
  databaseUrl: string | undefined;
  /** Exact browser origins allowed to call the API. Native apps send none and need none. */
  corsOrigins: string[];
  /** open = new devices may register an athlete identity; closed = only existing identities. */
  registration: 'open' | 'closed';
  /** Behind a reverse proxy: take the client address from the proxy's X-Forwarded-For. */
  trustProxy: boolean;
  /** null only in development without an OpenAI key/model: chat answers ai_unavailable. */
  ai: AIConfig | null;
}

export class ConfigError extends Error {
  name = 'ConfigError';
  constructor(public problems: string[]) {
    super(`Invalid APEX AI configuration: ${problems.join('; ')}`);
  }
}

function origins(raw: string | undefined, prod: boolean, problems: string[]): string[] {
  const v = raw?.trim();
  if (!v) {
    if (prod) problems.push('APEX_AI_CORS_ORIGINS is required in production (use "none" for native apps only)');
    return [];
  }
  if (v === 'none') return [];
  const list = v.split(',').map((o) => o.trim()).filter(Boolean);
  for (const o of list) {
    if (o.includes('*')) problems.push('APEX_AI_CORS_ORIGINS must list exact origins, never a wildcard');
    else if (!/^https?:\/\/[^/\s?#]+$/.test(o)) problems.push('APEX_AI_CORS_ORIGINS has an entry that is not an origin (scheme://host[:port])');
    else if (prod && !o.startsWith('https://')) problems.push('APEX_AI_CORS_ORIGINS must use https:// origins in production');
  }
  return list;
}

/**
 * Reads and checks everything the server needs. APEX_ENV must say which world this is — there is
 * no default, so a production deploy can never fall back to development behaviour. Problems name
 * variables, never their values.
 */
export function loadServerConfig(env: Env = process.env): ServerConfig {
  const mode = env.APEX_ENV;
  if (mode !== 'development' && mode !== 'production') throw new ConfigError(['APEX_ENV must be set to "development" or "production"']);
  const prod = mode === 'production';
  const problems: string[] = [];

  const secret = env.APEX_AUTH_SECRET ?? '';
  if (secret.length < 32) problems.push('APEX_AUTH_SECRET must be at least 32 characters');
  if (prod && new Set(secret).size < 12) problems.push('APEX_AUTH_SECRET is too predictable for production');

  const databaseUrl = env.DATABASE_URL?.trim() || undefined;
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) problems.push('DATABASE_URL must be a postgres:// connection string');
  if (prod && !databaseUrl) problems.push('DATABASE_URL is required in production');

  const corsOrigins = origins(env.APEX_AI_CORS_ORIGINS, prod, problems);

  const registration = env.APEX_AI_REGISTRATION ?? (prod ? undefined : 'open');
  if (registration !== 'open' && registration !== 'closed') problems.push(`APEX_AI_REGISTRATION must be "open" or "closed"${prod ? ' (required in production)' : ''}`);

  let ai: AIConfig | null = null;
  try {
    ai = loadAIConfig(env);
  } catch (e) {
    // development may run without a model (chat answers "unavailable"); production may not
    if (prod || env.OPENAI_API_KEY || env.APEX_AI_MODEL) problems.push((e as Error).message);
  }
  if (prod) {
    if (env.OPENAI_BASE_URL) problems.push('OPENAI_BASE_URL must not be set in production (no mock or proxy model endpoints)');
    if (ai && !/^sk-[A-Za-z0-9_-]{20,}$/.test(ai.apiKey)) problems.push('OPENAI_API_KEY does not look like an OpenAI API key');
  }

  if (problems.length) throw new ConfigError(problems);
  return { env: mode, authSecret: secret, databaseUrl, corsOrigins, registration: registration as 'open' | 'closed', trustProxy: env.APEX_TRUST_PROXY === '1', ai };
}

