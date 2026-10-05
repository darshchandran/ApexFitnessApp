// APEX AI on the device: a small client for the APEX AI backend (never OpenAI — the key lives on
// the server) and one bounded conversation kept on this device. The install signs itself in
// (aiSession.ts: refresh token in secure storage, short-lived access token in memory). Actions the
// athlete confirms come back as records and are stored through the app's own service
// (applyActionChanges). Nothing here logs — no tokens, no athlete data, no message text.
import type { KeyValueStore } from '../data/store';
import type { ApexData, ISODate } from '../domain/types';
import { createSession, memorySecrets, SessionError, type SecretStore } from './aiSession';
import type { ActionChanges } from './apex';

export type Mode = 'fast' | 'default' | 'deep';
/** The backend's message limit (backend/ai/config.ts → maxMessageChars). */
export const MAX_MESSAGE = 2000;
const MAX_STORED = 40;
const MAX_TEXT = 4000; // per stored message
const MAX_REPLY = 20_000; // a reply this long is still shown in full until it is stored
const CHAT_TIMEOUT = 45_000;
const ACTION_TIMEOUT = 30_000;
export const CONVERSATION_KEY = 'apex:v1:ai-conversation';
export const CONNECTION_KEY = 'apex:v1:ai-connection';

export interface Connection {
  url: string;
  /** Entered on the device (development builds only) rather than built in. */
  custom: boolean;
}

export type ActionState = 'pending' | 'confirming' | 'cancelling' | 'executed' | 'cancelled' | 'expired' | 'failed';

export interface ProposedAction {
  id: string;
  type: string;
  summary: string;
  arguments: Record<string, unknown>;
  preview: string[];
  expiresAt: string;
  state: ActionState;
  /** What happened, in plain words (success, why it failed, what to do next). */
  note?: string;
}

export interface UserMessage {
  id: string;
  role: 'user';
  text: string;
  at: string;
  status: 'sending' | 'sent' | 'failed';
  error?: string;
  /** Safe to send again (read-only chat). */
  retry?: boolean;
}

export interface ApexMessage {
  id: string;
  role: 'apex';
  text: string;
  at: string;
  /** What APEX looked at, in plain words ("training load", "today's plan"). */
  checked: string[];
  action?: ProposedAction;
}

export type Message = UserMessage | ApexMessage;

export interface AIState {
  ready: boolean;
  connection: Connection | null;
  conversationId: string | null;
  mode: Mode;
  messages: Message[];
  sending: boolean;
  /** This device couldn't sign in to APEX AI (the server refused it even after a refresh). */
  authFailed: boolean;
}

/** The slice of the app service the assistant needs. */
export interface ApexLink {
  getState(): { data: ApexData };
  today(): ISODate;
  applyActionChanges(ch: ActionChanges): number;
}

const TOOL_LABEL: Record<string, string> = {
  get_athlete_profile: 'profile', get_training_schedule: 'weekly schedule', get_today_plan: 'today’s plan',
  get_current_adaptation: 'today’s adaptation', get_training_load: 'training load', get_readiness: 'readiness',
  get_recent_sessions: 'recent sessions', get_workout_history: 'workout history', get_exercise_history: 'exercise history',
  get_progression: 'progression', get_prs: 'PRs', get_weekly_volume: 'weekly volume',
};

export const NOTE = {
  expired: 'This action has expired. Ask APEX AI again if you still want to do this.',
  cancelled: 'Cancelled — nothing was changed.',
  offline: 'Couldn’t reach APEX AI. Nothing has changed on this device — try again.',
  unavailable: 'APEX AI couldn’t confirm this right now. Nothing has changed on this device.',
  reconnect: 'APEX AI couldn’t sign in on this device. Try again, then confirm.',
};

const DONE: Record<string, (a: ProposedAction) => string> = {
  log_basketball: () => 'Basketball session logged.',
  adapt_today_workout: (a) => (a.arguments.choice === 'recovery_day' ? 'Recovery day set.' : a.arguments.choice === 'alternative' ? 'Today’s session switched.' : 'Today’s workout adapted.'),
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.length <= max;
let seq = 0;
const uid = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

/** A server-written, athlete-facing reason (only for action failures) — never a raw error. */
const reason = (j: unknown) => {
  const m = isObj(j) && isObj(j.result) && isObj(j.result.error) ? j.result.error.message : undefined;
  return str(m, 200) && m.trim() ? m.trim() : undefined;
};
const errorCode = (j: unknown) => (isObj(j) && isObj(j.error) && typeof j.error.code === 'string' ? j.error.code : undefined);

function readAction(v: unknown): ProposedAction | null {
  if (!isObj(v) || !str(v.id, 64) || !str(v.type, 40) || !str(v.summary, 500) || !isObj(v.arguments) || !str(v.expires_at, 40)) return null;
  if (!Array.isArray(v.preview) || !v.preview.every((p) => str(p, 300)) || Number.isNaN(Date.parse(v.expires_at))) return null;
  return { id: v.id, type: v.type, summary: v.summary, arguments: v.arguments, preview: v.preview as string[], expiresAt: v.expires_at, state: 'pending' };
}

/** The /ai/chat contract; anything else is "malformed". */
function readChat(j: unknown) {
  if (!isObj(j) || !str(j.message, MAX_REPLY) || !j.message.trim() || !str(j.conversation_id, 64) || !/^[\w-]+$/.test(j.conversation_id)) return null;
  const action = j.action_required === true ? readAction(j.action) : null;
  if (j.action_required === true && !action) return null;
  const tools = Array.isArray(j.tools_used) ? j.tools_used.filter((t): t is string => typeof t === 'string') : [];
  return { conversationId: j.conversation_id, text: j.message.trim(), checked: [...new Set(tools.map((t) => TOOL_LABEL[t]).filter(Boolean))], action };
}

const validChanges = (c: unknown): c is ActionChanges => isObj(c) && Array.isArray(c.basketball) && Array.isArray(c.instances);

class RequestFailed extends Error {
  constructor(public kind: 'offline' | 'timeout' | 'http' | 'malformed' | 'signin', public status = 0, public body?: unknown) {
    super(kind);
  }
}

/** Plain words for a failed chat request, and whether sending it again is safe and useful. */
export function chatError(e: unknown): { text: string; retry: boolean } {
  if (!(e instanceof RequestFailed)) return { text: 'Something went wrong. Try again.', retry: true };
  if (e.kind === 'offline') return { text: 'Couldn’t reach APEX AI. Check your connection and try again.', retry: true };
  if (e.kind === 'timeout') return { text: 'APEX AI took too long to answer. Try again.', retry: true };
  if (e.kind === 'malformed') return { text: 'APEX AI sent a reply this app couldn’t read. Try again.', retry: true };
  if (e.kind === 'signin') return e.body === 'closed'
    ? { text: 'APEX AI isn’t open to new devices right now.', retry: false }
    : { text: 'APEX AI couldn’t sign in right now. Try again.', retry: true };
  if (e.status === 401) return { text: 'APEX AI couldn’t sign in on this device.', retry: false };
  if (e.status === 429) return { text: 'That’s a lot of questions in a short time. Try again in a few minutes.', retry: true };
  if (e.status === 413) return { text: 'Your training data is too large to send right now.', retry: false };
  if (e.status >= 400 && e.status < 500) return { text: 'That message couldn’t be sent. Try rephrasing it.', retry: false };
  return { text: 'APEX AI is unavailable right now. Your training data isn’t affected.', retry: true };
}

function stored(raw: string | null): { conversationId: string | null; mode: Mode; messages: Message[] } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!isObj(v) || !Array.isArray(v.messages)) return null;
    const messages = v.messages.flatMap((m): Message[] => {
      if (!isObj(m) || !str(m.id, 40) || !str(m.text) || !str(m.at, 40)) return [];
      if (m.role === 'user') {
        // a send that never finished (app closed) didn't reach APEX as far as we know
        const status = m.status === 'sent' ? 'sent' : 'failed';
        return [{ id: m.id, role: 'user', text: m.text, at: m.at, status, ...(status === 'failed' && { error: str(m.error, 200) ? m.error : 'Not sent.', retry: true }) }];
      }
      if (m.role !== 'apex') return [];
      const a = isObj(m.action) ? m.action : undefined;
      const action = a && readAction({ ...a, expires_at: a.expiresAt });
      // an action interrupted mid-confirm is pending again: confirming it again is safe (the server runs it once)
      const state = a && ['executed', 'cancelled', 'expired', 'failed'].includes(a.state as string) ? (a.state as ActionState) : 'pending';
      const checked = Array.isArray(m.checked) ? m.checked.filter((c): c is string => str(c, 40)) : [];
      return [{ id: m.id, role: 'apex', text: m.text, at: m.at, checked, ...(action && { action: { ...action, state, ...(str(a!.note, 300) && { note: a!.note }) } }) }];
    });
    const mode = v.mode === 'fast' || v.mode === 'deep' ? v.mode : 'default';
    return { conversationId: str(v.conversationId, 64) ? v.conversationId : null, mode, messages };
  } catch {
    return null;
  }
}

/**
 * The AI server address a build may use. Production builds only talk to an https:// server that
 * isn't on this machine; anything else turns APEX AI off in that build rather than downgrading.
 */
export function aiServerUrl(value: string | undefined, dev: boolean): string | undefined {
  const url = value?.trim().replace(/\/+$/, '');
  if (!url) return undefined;
  if (dev) return url;
  return /^https:\/\/[^\s/]+$/.test(url) && !/^https:\/\/(localhost|127\.|10\.|192\.168\.|\[::1\])/i.test(url) ? url : undefined;
}

export function createAssistant(deps: {
  store: KeyValueStore;
  apex: ApexLink;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Where the refresh token lives: the device's secure store (memory on web and in tests). */
  secrets?: SecretStore;
  defaultUrl?: string;
  now?: () => Date;
  timeouts?: { chat?: number; action?: number };
}) {
  const now = deps.now ?? (() => new Date());
  const doFetch = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const session = createSession({ secrets: deps.secrets ?? memorySecrets(), fetch: doFetch, now: () => now().getTime() });
  const builtInUrl = (deps.defaultUrl ?? '').trim().replace(/\/+$/, '');
  const listeners = new Set<() => void>();
  let state: AIState = { ready: false, connection: null, conversationId: null, mode: 'default', messages: [], sending: false, authFailed: false };
  /** Bumped by "new conversation": replies for an older conversation are dropped, never mixed in. */
  let generation = 0;
  let writes: Promise<unknown> = Promise.resolve();

  const set = (patch: Partial<AIState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };
  const persist = () => {
    const body = JSON.stringify({
      v: 1, conversationId: state.conversationId, mode: state.mode,
      messages: state.messages.slice(-MAX_STORED).map((m) => ({ ...m, text: m.text.slice(0, MAX_TEXT) })),
    });
    writes = writes.then(() => deps.store.setItem(CONVERSATION_KEY, body)).catch(() => undefined);
    return writes;
  };
  const update = (id: string, fn: (m: Message) => Message, patch: Partial<AIState> = {}) => {
    set({ ...patch, messages: state.messages.map((m) => (m.id === id ? fn(m) : m)) });
    void persist();
  };
  const patchAction = (msgId: string, a: Partial<ProposedAction>) =>
    update(msgId, (m) => (m.role === 'apex' && m.action ? { ...m, action: { ...m.action, ...a } } : m));
  const actionOf = (msgId: string) => {
    const m = state.messages.find((x) => x.id === msgId);
    return m?.role === 'apex' ? m.action : undefined;
  };
  const expired = (a: ProposedAction) => Date.parse(a.expiresAt) <= now().getTime();

  /** One authorized request; a refused access token is refreshed once and the request sent again. */
  async function call(path: string, body: unknown, timeoutMs: number) {
    const c = state.connection;
    if (!c) throw new RequestFailed('http', 401);
    const token = async () => {
      try {
        return await session.token(c.url);
      } catch (e) {
        if (e instanceof SessionError) throw e.kind === 'offline' ? new RequestFailed('offline') : new RequestFailed('signin', 0, e.kind);
        throw e;
      }
    };
    let r = await request(c.url, path, body, await token(), timeoutMs);
    if (r.status === 401) {
      session.invalidate();
      r = await request(c.url, path, body, await token(), timeoutMs);
    }
    return r;
  }

  async function request(url: string, path: string, body: unknown, token: string, timeoutMs: number) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await doFetch(`${url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
          signal: abort.signal,
        });
      } catch {
        throw new RequestFailed(abort.signal.aborted ? 'timeout' : 'offline');
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new RequestFailed(abort.signal.aborted ? 'timeout' : 'malformed', res.status);
      }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  const context = () => ({ today: deps.apex.today(), athlete_data: deps.apex.getState().data });

  async function deliver(userId: string): Promise<boolean> {
    const gen = generation;
    const msg = state.messages.find((m) => m.id === userId);
    if (!msg) return false;
    try {
      const { status, json } = await call('/ai/chat', {
        message: msg.text, mode: state.mode, ...(state.conversationId && { conversation_id: state.conversationId }), context: context(),
      }, deps.timeouts?.chat ?? CHAT_TIMEOUT);
      if (status !== 200) throw new RequestFailed('http', status, json);
      const r = readChat(json);
      if (!r) throw new RequestFailed('malformed', status);
      if (gen !== generation) return false;
      const reply: ApexMessage = { id: uid(), role: 'apex', text: r.text, at: now().toISOString(), checked: r.checked, ...(r.action && { action: r.action }) };
      set({
        sending: false, conversationId: r.conversationId,
        messages: [...state.messages.map((m) => (m.id === userId ? { ...msg, status: 'sent' as const } : m)), reply],
      });
      void persist();
      return true;
    } catch (e) {
      if (gen !== generation) return false;
      const { text, retry } = chatError(e);
      const auth = e instanceof RequestFailed && e.status === 401;
      update(userId, () => ({ ...msg, status: 'failed', error: text, retry }), { sending: false, ...(auth && { authFailed: true }) });
      return false;
    }
  }

  const api = {
    getState: () => state,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },

    async init() {
      const [conv, conn] = await Promise.all([
        deps.store.getItem(CONVERSATION_KEY).catch(() => null),
        deps.store.getItem(CONNECTION_KEY).catch(() => null),
      ]);
      const restored = stored(conv);
      if (conv && !restored) await deps.store.removeItem(CONVERSATION_KEY).catch(() => undefined); // unreadable: start clean
      let custom: string | null = null;
      try {
        const c = conn ? JSON.parse(conn) : null;
        if (isObj(c) && str(c.url, 300) && /^https?:\/\//.test(c.url)) custom = c.url;
        // earlier builds kept a pasted access token here in plain storage: drop it
        if (isObj(c) && 'token' in c) await deps.store.setItem(CONNECTION_KEY, JSON.stringify(custom ? { url: custom } : {}));
      } catch {
        // unreadable: fall back to the built-in server
      }
      const connection = custom ? { url: custom, custom: true } : builtInUrl ? { url: builtInUrl, custom: false } : null;
      set({ ready: true, connection, ...(restored ?? {}) });
    },

    /** The server address built into the app (EXPO_PUBLIC_APEX_AI_URL), if any. */
    defaultUrl: builtInUrl,

    /** Development builds only: use an APEX AI server entered on the device. No credentials are entered. */
    async connect(url: string) {
      const u = url.trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^\s/]+$/.test(u)) return false;
      set({ connection: { url: u, custom: true }, authFailed: false });
      await deps.store.setItem(CONNECTION_KEY, JSON.stringify({ url: u })).catch(() => undefined);
      return true;
    },

    /** Signs this device out of the server and forgets an entered server address. */
    async disconnect() {
      const c = state.connection;
      if (c) await session.signOut(c.url).catch(() => undefined);
      set({ connection: builtInUrl ? { url: builtInUrl, custom: false } : null, authFailed: false });
      await deps.store.removeItem(CONNECTION_KEY).catch(() => undefined);
    },

    /** After a sign-in failure: try again with a fresh sign-in on the next request. */
    retrySignIn() {
      session.invalidate();
      set({ authFailed: false });
    },

    setMode(mode: Mode) {
      set({ mode });
      void persist();
    },

    /** Resolves true once APEX answered (the composer clears only then). */
    async send(text: string) {
      const message = text.trim();
      if (!message || message.length > MAX_MESSAGE || state.sending || !state.connection || state.authFailed) return false;
      const user: UserMessage = { id: uid(), role: 'user', text: message, at: now().toISOString(), status: 'sending' };
      // sending again replaces an earlier message that didn't go through
      set({ sending: true, messages: [...state.messages.filter((m) => !(m.role === 'user' && m.status === 'failed')), user] });
      return deliver(user.id);
    },

    /** Send a failed question again (read-only, so always safe). */
    async retry(messageId: string) {
      const m = state.messages.find((x) => x.id === messageId);
      if (!m || m.role !== 'user' || m.status !== 'failed' || !m.retry || state.sending || !state.connection) return false;
      update(messageId, () => ({ ...m, status: 'sending', error: undefined, retry: undefined }), { sending: true });
      return deliver(messageId);
    },

    /** Clears the AI conversation only — never athlete data, history, settings or the profile. */
    newConversation() {
      generation++;
      set({ conversationId: null, messages: [], sending: false });
      return persist();
    },

    /** Confirm a proposed action: one request at a time, never retried automatically. */
    async confirm(messageId: string) {
      const a = actionOf(messageId);
      if (!a || a.state !== 'pending' || !state.connection) return;
      if (expired(a)) return patchAction(messageId, { state: 'expired', note: NOTE.expired });
      patchAction(messageId, { state: 'confirming', note: undefined });
      try {
        const { status, json } = await call(`/ai/actions/${encodeURIComponent(a.id)}/confirm`, { arguments: a.arguments, context: context() }, deps.timeouts?.action ?? ACTION_TIMEOUT);
        if (status === 200) {
          const r = isObj(json) && isObj(json.result) ? json.result : undefined;
          const changes = r?.success === true && isObj(r.result) ? r.result.changes : undefined;
          // executed on the server but unreadable here: confirming again returns the same result
          if (!validChanges(changes)) return patchAction(messageId, { state: 'pending', note: 'APEX AI’s reply couldn’t be read. Confirm again to finish — it won’t run twice.' });
          deps.apex.applyActionChanges(changes);
          return patchAction(messageId, { state: 'executed', note: (DONE[a.type] ?? (() => 'Done.'))(a) });
        }
        const code = errorCode(json);
        if (status === 410) return patchAction(messageId, { state: 'expired', note: NOTE.expired });
        if (status === 409 && code === 'action_cancelled') return patchAction(messageId, { state: 'cancelled', note: 'This action was cancelled. Ask APEX AI again if you still want to do this.' });
        if (status === 409 && code === 'arguments_changed') return patchAction(messageId, { state: 'failed', note: 'This action changed after it was proposed, so it was cancelled. Ask APEX AI again.' });
        if (status === 409) return patchAction(messageId, { state: 'failed', note: 'This action is no longer waiting for confirmation.' });
        if (status === 422) return patchAction(messageId, { state: 'failed', note: `Nothing was changed. ${reason(json) ?? 'APEX couldn’t carry this out.'}` });
        if (status === 403) return patchAction(messageId, { state: 'failed', note: 'This action isn’t available.' });
        if (status === 404) return patchAction(messageId, { state: 'failed', note: 'This action is no longer available. Ask APEX AI again.' });
        if (status === 400) return patchAction(messageId, { state: 'failed', note: 'This action couldn’t be confirmed. Ask APEX AI again.' });
        if (status === 401) {
          patchAction(messageId, { state: 'pending', note: NOTE.reconnect });
          return set({ authFailed: true });
        }
        if (status === 429) return patchAction(messageId, { state: 'pending', note: 'Too many requests. Wait a minute, then confirm again.' });
        return patchAction(messageId, { state: 'pending', note: NOTE.unavailable });
      } catch (e) {
        // the request may or may not have reached the server; confirming again is safe (it runs once there)
        const kind = e instanceof RequestFailed ? e.kind : 'offline';
        return patchAction(messageId, { state: 'pending', note: kind === 'offline' || kind === 'timeout' ? NOTE.offline : NOTE.unavailable });
      }
    },

    async cancel(messageId: string) {
      const a = actionOf(messageId);
      if (!a || a.state !== 'pending' || !state.connection) return;
      if (expired(a)) return patchAction(messageId, { state: 'expired', note: NOTE.expired });
      patchAction(messageId, { state: 'cancelling', note: undefined });
      try {
        const { status, json } = await call(`/ai/actions/${encodeURIComponent(a.id)}/cancel`, {}, deps.timeouts?.action ?? ACTION_TIMEOUT);
        if (status === 200 || status === 404) return patchAction(messageId, { state: 'cancelled', note: NOTE.cancelled });
        const serverState = isObj(json) && isObj(json.action) ? json.action.status : undefined;
        if (status === 409 && serverState === 'expired') return patchAction(messageId, { state: 'expired', note: NOTE.expired });
        if (status === 409) return patchAction(messageId, { state: 'failed', note: 'This action is no longer waiting for confirmation.' });
        if (status === 401) {
          patchAction(messageId, { state: 'pending', note: NOTE.reconnect });
          return set({ authFailed: true });
        }
        return patchAction(messageId, { state: 'pending', note: 'Couldn’t cancel right now. If you leave it, it expires on its own in a few minutes.' });
      } catch {
        return patchAction(messageId, { state: 'pending', note: 'Couldn’t reach APEX AI to cancel. If you leave it, it expires on its own in a few minutes.' });
      }
    },

    /** Mark a pending action expired once its time is up (the card's timer calls this). */
    expire(messageId: string) {
      const a = actionOf(messageId);
      if (a?.state === 'pending' && expired(a)) patchAction(messageId, { state: 'expired', note: NOTE.expired });
    },

    /** Resolves when pending writes have reached storage (tests). */
    flush: () => writes,
  };
  return api;
}

export type Assistant = ReturnType<typeof createAssistant>;
