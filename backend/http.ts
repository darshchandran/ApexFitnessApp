// node:http → the AI routes (Request/Response). Used by server.ts and the integration tests.
import { createServer, type IncomingMessage } from 'node:http';
import { readiness, route, type ChatDeps } from './ai/handler';

const notFound = JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } });
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
 * `corsOrigins`: exact browser origins allowed to call the API (the web build). Native apps send no
 * Origin and need none. Empty = no browser origin is allowed.
 */
export const createAIServer = (deps: ChatDeps, { corsOrigins = [] as string[], trustProxy = false } = {}) => {
  const cors = (req: IncomingMessage): Record<string, string> => {
    const origin = req.headers.origin;
    return origin && corsOrigins.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
  };
  return createServer(async (req, res) => {
    // liveness (the process answers) and readiness (it can serve): for the host's health checks
    if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/readyz')) {
      const r = req.url === '/healthz' ? { status: 200, body: { status: 'ok' } } : await readiness(deps);
      return res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(r.body));
    }
    if (!req.url?.startsWith('/ai/')) return res.writeHead(404, { 'content-type': 'application/json' }).end(notFound);
    if (req.method === 'OPTIONS') {
      const allowed = cors(req);
      return res.writeHead(allowed['access-control-allow-origin'] ? 204 : 403, {
        ...allowed,
        ...(allowed['access-control-allow-origin'] && { 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' }),
      }).end();
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > deps.limits.maxBodyBytes) {
        res.writeHead(413, { 'content-type': 'application/json', ...cors(req) }).end(tooLarge);
        return req.destroy();
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const out = await route(
      new Request(`http://localhost${req.url}`, { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }),
      deps,
      { clientIp: clientAddress(req, trustProxy) },
    );
    res.writeHead(out.status, { ...Object.fromEntries(out.headers), ...cors(req) }).end(await out.text());
  });
};
