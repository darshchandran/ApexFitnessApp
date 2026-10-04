// node:http → the AI routes (Request/Response). Used by server.ts and the integration test.
import { createServer } from 'node:http';
import { route, type ChatDeps } from './ai/handler';

const notFound = JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } });
const tooLarge = JSON.stringify({ error: { code: 'payload_too_large', message: 'That request is too large.' } });

export const createAIServer = (deps: ChatDeps) =>
  createServer(async (req, res) => {
    if (!req.url?.startsWith('/ai/')) return res.writeHead(404, { 'content-type': 'application/json' }).end(notFound);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > deps.limits.maxBodyBytes) {
        res.writeHead(413, { 'content-type': 'application/json' }).end(tooLarge);
        return req.destroy();
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const out = await route(new Request(`http://localhost${req.url}`, { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }), deps);
    res.writeHead(out.status, Object.fromEntries(out.headers)).end(await out.text());
  });
