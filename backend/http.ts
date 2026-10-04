// node:http → the AI routes (Request/Response). Used by server.ts and the integration test.
import { createServer, type IncomingMessage } from 'node:http';
import { route, type ChatDeps } from './ai/handler';

const notFound = JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } });
const tooLarge = JSON.stringify({ error: { code: 'payload_too_large', message: 'That request is too large.' } });

/**
 * `corsOrigins`: browser origins allowed to call the API (the web build). Native apps don't send an
 * Origin and need none. Empty by default — a browser on any other site gets no CORS headers.
 */
export const createAIServer = (deps: ChatDeps, { corsOrigins = [] as string[] } = {}) => {
  const cors = (req: IncomingMessage): Record<string, string> => {
    const origin = req.headers.origin;
    return origin && corsOrigins.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
  };
  return createServer(async (req, res) => {
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
    const out = await route(new Request(`http://localhost${req.url}`, { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }), deps);
    res.writeHead(out.status, { ...Object.fromEntries(out.headers), ...cors(req) }).end(await out.text());
  });
};
