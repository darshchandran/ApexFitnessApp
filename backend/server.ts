// APEX backend: POST /ai/chat. `npm run ai:server` — reads .env; the OpenAI key stays in this process.
import { createServer } from 'node:http';
import OpenAI from 'openai';
import { createChatDeps, handleChat } from './ai/handler';
import type { ResponsesClient } from './ai/service';

try {
  process.loadEnvFile();
} catch {
  // no .env file: use the environment as is
}

const deps = createChatDeps(process.env, (apiKey) => new OpenAI({ apiKey, maxRetries: 1 }) as unknown as ResponsesClient);
const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '127.0.0.1';
const json = (status: number, code: string, message: string) => [status, { 'content-type': 'application/json' }, JSON.stringify({ error: { code, message } })] as const;

createServer(async (req, res) => {
  const send = ([status, headers, body]: readonly [number, Record<string, string>, string]) => res.writeHead(status, headers).end(body);
  if (req.url?.split('?')[0] !== '/ai/chat') return send(json(404, 'not_found', 'Not found.'));
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > deps.limits.maxBodyBytes) {
      send(json(413, 'payload_too_large', 'That request is too large.'));
      return req.destroy();
    }
    chunks.push(chunk);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const out = await handleChat(new Request(`http://${host}:${port}/ai/chat`, { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }), deps);
  send([out.status, Object.fromEntries(out.headers), await out.text()]);
}).listen(port, host, () => console.info(JSON.stringify({ event: 'ai.server', host, port, ai: !!deps.ai, auth: !!deps.secret })));
