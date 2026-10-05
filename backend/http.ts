// The AI routes as one Request → Response function (`serve`), plus its node:http adapter
// (`createAIServer`, used by server.ts and the integration tests). edge.ts serves the same
// function on Supabase Edge Functions.
import { createServer, type IncomingMessage } from 'node:http';
import { ConfigError } from './ai/config';
import { readiness, route, type ChatDeps } from './ai/handler';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const notFound = { error: { code: 'not_found', message: 'Not found.' } };
const tooLarge = JSON.stringify({ error: { code: 'payload_too_large', message: 'That request is too large.' } });

/**
 * The client address for per-address limits (registration, refresh). Without a trusted proxy it is
 * the socket's peer — headers can't change it. Behind one (APEX_TRUST_PROXY=1) it is the address the
 * proxy appended last to X-Forwarded-For; anything earlier in that header came from the client.
 */
export function clientAddress(req: IncomingMessage, trustProxy: boolean) {
  const forwarded = req.headers['x-forwarded-for'];
  if (trustProxy && typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',').at(-1)!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Health checks, CORS and the AI routes. `corsOrigins`: exact browser origins allowed to call the
 * API (the web build); native apps send no Origin and need none. `clientIp`: the address the
 * runtime observed — never a header the client controls.
 */
export async function serve(req: Request, deps: ChatDeps, { corsOrigins = [] as string[], clientIp = 'unknown' } = {}): Promise<Response> {
  const path = new URL(req.url).pathname;
  const origin = req.headers.get('origin');
  const cors: Record<string, string> = origin && corsOrigins.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
  // liveness (the process answers) and readiness (it can serve): for the host's health checks
  if (req.method === 'GET' && (path === '/healthz' || path === '/readyz')) {
    const r = path === '/healthz' ? { status: 200, body: { status: 'ok' } } : await readiness(deps);
    return json(r.status, r.body, { 'cache-control': 'no-store' });
  }
  if (!path.startsWith('/ai/')) return json(404, notFound);
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: cors['access-control-allow-origin'] ? 204 : 403,
      headers: cors['access-control-allow-origin'] ? { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' } : {},
    });
  }
  const out = await route(req, deps, { clientIp });
  return new Response(out.body, { status: out.status, headers: { ...Object.fromEntries(out.headers), ...cors } });
}

export const createAIServer = (deps: ChatDeps, { corsOrigins = [] as string[], trustProxy = false } = {}) =>
  createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > deps.limits.maxBodyBytes) {
        const origin = req.headers.origin;
        res.writeHead(413, { 'content-type': 'application/json', ...(origin && corsOrigins.includes(origin) && { 'access-control-allow-origin': origin, vary: 'origin' }) }).end(tooLarge);
        return req.destroy();
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const out = await serve(
      new Request(`http://localhost${req.url}`, { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }),
      deps,
      { corsOrigins, clientIp: clientAddress(req, trustProxy) },
    );
    res.writeHead(out.status, Object.fromEntries(out.headers)).end(await out.text());
  });

/** An error message with connection strings and anything that looks like a key masked. */
const scrub = (m: unknown) => String(m ?? '').replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '<url>').replace(/\b(sk|rt|v1|dev1)[-_.][\w.-]{8,}/g, '<secret>').slice(0, 300);

/** The startup-failure log line: configuration problems name variables, never values; anything else is scrubbed. */
export const startupFailure = (e: any) =>
  e instanceof ConfigError ? { event: 'ai.config', problems: e.problems } : { event: 'ai.startup_failed', category: e?.name ?? 'error', code: e?.code, message: scrub(e?.message) };
