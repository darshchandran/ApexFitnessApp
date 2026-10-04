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
