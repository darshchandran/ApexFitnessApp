// Contracts at the AI boundary: tool input/output schemas, the chat request/response, errors, and
// the confirmation contract for writes. Everything that crosses in from the model or the client is
// checked here before it reaches APEX code.
import type { ISODate } from '../../src/domain/types';
import type { AILimits, ModelMode } from './config';

type SchemaType = 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object' | 'null';

/** The JSON Schema subset APEX uses — also valid for OpenAI strict function calling. */
export interface Schema {
  type: SchemaType | readonly [SchemaType, 'null'];
  description?: string;
  enum?: readonly (string | null)[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  pattern?: string;
  items?: Schema;
  maxItems?: number;
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: false;
}

export const S = {
  str: (description?: string): Schema => ({ type: 'string', ...(description && { description }) }),
  text: (pattern: string, description?: string): Schema => ({ type: 'string', pattern, ...(description && { description }) }),
  int: (minimum: number, maximum: number, description?: string): Schema => ({ type: 'integer', minimum, maximum, ...(description && { description }) }),
  num: (): Schema => ({ type: 'number' }),
  bool: (): Schema => ({ type: 'boolean' }),
  oneOf: (values: readonly string[], description?: string): Schema => ({ type: 'string', enum: values, ...(description && { description }) }),
  list: (items: Schema, maxItems?: number): Schema => ({ type: 'array', items, ...(maxItems && { maxItems }) }),
  /** Strict object: every property required, nothing else allowed (OpenAI strict mode). */
  obj: (properties: Record<string, Schema>, description?: string): Schema => ({
    type: 'object', properties, required: Object.keys(properties), additionalProperties: false, ...(description && { description }),
  }),
  /** Optional in strict mode = required but nullable. */
  orNull: (s: Schema): Schema => ({ ...s, type: [s.type as SchemaType, 'null'], ...(s.enum && { enum: [...s.enum, null] }) }),
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** First problem as "path: reason", or null when valid. Never echoes the value itself. */
export function check(schema: Schema, v: unknown, path = '$'): string | null {
  const types: readonly SchemaType[] = typeof schema.type === 'string' ? [schema.type] : schema.type;
  if (v === null) return types.includes('null') ? null : `${path}: must not be null`;
  const t = types.find((x) => x !== 'null');
  if (t === 'string') {
    if (typeof v !== 'string') return `${path}: expected a string`;
    if (schema.maxLength !== undefined && v.length > schema.maxLength) return `${path}: too long`;
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(v)) return `${path}: wrong format`;
  } else if (t === 'integer' || t === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v) || (t === 'integer' && !Number.isInteger(v))) return `${path}: expected ${t === 'integer' ? 'an integer' : 'a number'}`;
    if (schema.minimum !== undefined && v < schema.minimum) return `${path}: below ${schema.minimum}`;
    if (schema.maximum !== undefined && v > schema.maximum) return `${path}: above ${schema.maximum}`;
  } else if (t === 'boolean') {
    if (typeof v !== 'boolean') return `${path}: expected true or false`;
  } else if (t === 'array') {
    if (!Array.isArray(v)) return `${path}: expected a list`;
    if (schema.maxItems !== undefined && v.length > schema.maxItems) return `${path}: too many items`;
    for (let i = 0; i < v.length; i++) {
      const p = schema.items && check(schema.items, v[i], `${path}[${i}]`);
      if (p) return p;
    }
  } else if (t === 'object') {
    if (!isObject(v)) return `${path}: expected an object`;
    const props = schema.properties;
    if (props) {
      for (const k of schema.required ?? []) if (!(k in v)) return `${path}.${k}: missing`;
      for (const [k, x] of Object.entries(v)) {
        if (!(k in props)) {
          if (schema.additionalProperties === false) return `${path}.${k}: not allowed`;
          continue;
        }
        const p = check(props[k], x, `${path}.${k}`);
        if (p) return p;
      }
    }
  } else {
    return `${path}: must be null`;
  }
  if (schema.enum && !schema.enum.includes(v as string)) return `${path}: not an allowed value`;
  return null;
}

// ---------- the chat contract ----------

export const ISO_DATE = '^\\d{4}-\\d{2}-\\d{2}$';

export interface AIMessageRequest {
  /** Omit to start a conversation; the response returns the id to continue it. */
  conversation_id?: string;
  message: string;
  /** Which configured model to use: APEX_FAST_MODEL, APEX_AI_MODEL or APEX_DEEP_MODEL. */
  mode?: ModelMode;
  context?: {
    /** The athlete's local calendar date (APEX dates are local, the server's clock isn't). */
    today?: ISODate;
    /** The device's own APEX data — validated like stored data, used for this request only, never kept. */
    athlete_data?: Record<string, unknown>;
  };
}

export const requestSchema = (limits: AILimits): Schema => ({
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: {
    conversation_id: S.text('^[A-Za-z0-9_-]{1,64}$'),
    message: { type: 'string', maxLength: limits.maxMessageChars },
    mode: S.oneOf(['fast', 'default', 'deep']),
    context: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: { today: S.text(ISO_DATE), athlete_data: { type: 'object' } },
    },
  },
});

/**
 * A write the AI may only *propose*. Nothing executes on the server: the app shows the proposal,
 * the athlete confirms, and the app's own service performs it (and reports the result).
 */
export interface ActionProposal {
  action: ActionName;
  arguments: Record<string, unknown>;
  summary: string;
  requires_confirmation: true;
}

export const BASKETBALL_TYPES = ['skills', 'shooting', 'conditioning', 'scrimmage', 'game', 'mixed'] as const;

/** Every action the AI can propose, with its argument contract. Future: log_gym_set, start/finish_workout, adapt_today_workout. */
export const ACTIONS = {
  log_basketball: S.obj({
    date: S.text(ISO_DATE),
    duration_min: S.int(1, 600),
    rpe: S.int(1, 10),
    session_type: S.orNull(S.oneOf(BASKETBALL_TYPES)),
  }),
} as const;
export type ActionName = keyof typeof ACTIONS;

export interface AIMessageResponse {
  conversation_id: string;
  message: string;
  model: string;
  prompt_version: string;
  /** Tool names only — no tool data. */
  tools_used: string[];
  /** Set when the AI proposed a write; the app must ask the athlete before doing anything. */
  action_required: ActionProposal | null;
}

export type AIErrorCode =
  | 'unauthorized' | 'rate_limited' | 'invalid_request' | 'payload_too_large' | 'method_not_allowed'
  | 'ai_unavailable' | 'timeout' | 'model_error' | 'tool_limit' | 'internal';

const UNAFFECTED = 'Your workouts and training data are not affected.';
export const ERRORS: Record<AIErrorCode, { status: number; message: string }> = {
  unauthorized: { status: 401, message: 'Sign in to use APEX AI.' },
  rate_limited: { status: 429, message: 'Too many AI requests. Try again in a few minutes.' },
  invalid_request: { status: 400, message: 'That request could not be read.' },
  payload_too_large: { status: 413, message: 'That request is too large.' },
  method_not_allowed: { status: 405, message: 'Use POST.' },
  ai_unavailable: { status: 503, message: `APEX AI is unavailable right now. ${UNAFFECTED}` },
  timeout: { status: 504, message: `APEX AI took too long to answer. ${UNAFFECTED}` },
  model_error: { status: 502, message: `APEX AI could not answer that. ${UNAFFECTED}` },
  tool_limit: { status: 502, message: `That question needed too many steps. Try asking something narrower. ${UNAFFECTED}` },
  internal: { status: 500, message: `Something went wrong with APEX AI. ${UNAFFECTED}` },
};

export interface AIErrorBody {
  error: { code: AIErrorCode; message: string; detail?: string };
}

/** `category` is for logs (e.g. upstream_rate_limit); `code` is what the client sees. */
export class AIError extends Error {
  name = 'AIError';
  constructor(public code: AIErrorCode, public category: string = code) {
    super(code);
  }
}
