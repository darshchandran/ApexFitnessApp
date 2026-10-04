// This install's APEX AI sign-in. APEX has no accounts yet, so the install registers its own athlete
// identity with the APEX AI server. The refresh token lives in the device's secure storage
// (Keychain / Keystore via expo-secure-store); the 15-minute access token only in memory. The
// server rotates the refresh token on every use. Nothing here is logged.

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const REFRESH_KEY = 'apex.ai.refresh';

/** Session-only storage (web, where there is no secure store): signing in again after a reload is fine. */
export function memorySecrets(): SecretStore {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => void m.set(k, v),
    remove: async (k) => void m.delete(k),
  };
}

/** Why this device couldn't get an access token. */
export class SessionError extends Error {
  constructor(public kind: 'offline' | 'closed' | 'unavailable') {
    super(kind);
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const tokens = (j: unknown) =>
  isObj(j) && typeof j.access_token === 'string' && typeof j.refresh_token === 'string' && typeof j.access_expires_at === 'string' && !Number.isNaN(Date.parse(j.access_expires_at))
    ? { access: j.access_token, refresh: j.refresh_token, exp: Date.parse(j.access_expires_at) }
    : null;

export function createSession(deps: { secrets: SecretStore; fetch: Fetch; now?: () => number }) {
  const now = deps.now ?? Date.now;
  let access: { token: string; exp: number; url: string } | null = null;
  /** One refresh/registration at a time: a second concurrent refresh would look like token theft. */
  let inflight: Promise<string> | null = null;

  async function post(url: string, path: string, body: unknown) {
    let res: Response;
    try {
      res = await deps.fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new SessionError('offline');
    }
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  async function keep(url: string, t: NonNullable<ReturnType<typeof tokens>>) {
    await deps.secrets.set(REFRESH_KEY, t.refresh);
    access = { token: t.access, exp: t.exp, url };
    return t.access;
  }

  async function acquire(url: string): Promise<string> {
    const refresh = await deps.secrets.get(REFRESH_KEY);
    if (refresh) {
      const r = await post(url, '/ai/auth/refresh', { refresh_token: refresh });
      const t = r.status === 200 ? tokens(r.json) : null;
      if (t) return keep(url, t);
      if (r.status !== 401) throw new SessionError('unavailable');
      await deps.secrets.remove(REFRESH_KEY); // spent, revoked or from another server: start a new identity
    }
    const r = await post(url, '/ai/auth/register', {});
    const t = r.status === 201 ? tokens(r.json) : null;
    if (t) return keep(url, t);
    throw new SessionError(r.status === 403 ? 'closed' : 'unavailable');
  }

  return {
    /** A current access token for this server: cached, refreshed, or (first use) registered. */
    token(url: string): Promise<string> {
      if (access && access.url === url && access.exp - 60_000 > now()) return Promise.resolve(access.token);
      inflight ??= acquire(url).finally(() => {
        inflight = null;
      });
      return inflight;
    },
    /** The server refused the access token: forget it; the next token() refreshes. */
    invalidate() {
      access = null;
    },
    /** Signs this device out of APEX AI (the server revokes the token's whole lineage). */
    async signOut(url: string) {
      const refresh = await deps.secrets.get(REFRESH_KEY);
      access = null;
      await deps.secrets.remove(REFRESH_KEY);
      if (refresh) await post(url, '/ai/auth/revoke', { refresh_token: refresh }).catch(() => undefined);
    },
  };
}

export type Session = ReturnType<typeof createSession>;
