// APEX backend: POST /ai/chat, POST /ai/actions/:id/confirm|cancel. `npm run ai:server` — reads .env; the OpenAI key stays in this process.
import OpenAI from 'openai';
import { createChatDeps } from './ai/handler';
import type { ResponsesClient } from './ai/service';
import { createAIServer } from './http';

try {
  process.loadEnvFile();
} catch {
  // no .env file: use the environment as is
}

const deps = createChatDeps(process.env, (apiKey) => new OpenAI({ apiKey, maxRetries: 1 }) as unknown as ResponsesClient);
const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '127.0.0.1';
createAIServer(deps).listen(port, host, () => console.info(JSON.stringify({ event: 'ai.server', host, port, ai: !!deps.ai, auth: !!deps.secret })));
