import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { memoryStore } from '../../data/store';
import { createApex } from '../apex';
import { CONNECTION_KEY, CONVERSATION_KEY, createAssistant, MAX_MESSAGE, type ApexMessage, type UserMessage } from '../ai';

const NOW = new Date(2026, 9, 7, 18);
const TOKEN = 'v1.eyJzdWIiOiJhIn0.sig-sig-sig';
type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };
type Reply = { status?: number; body?: unknown; raw?: string } | 'offline' | 'hang';

/** A stand-in server: answers each request from a queue and records what the app sent. */
function fakeServer(replies: Reply[]) {
  const calls: Call[] = [];
  const fetch = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const r = replies.shift() ?? { body: { conversation_id: 'c1', message: 'ok' } };
    if (r === 'offline') throw new TypeError('Network request failed');
    if (r === 'hang') return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    return new Response(r.raw ?? JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  return { fetch, calls };
}

async function setup(replies: Reply[] = [], opts: { store?: ReturnType<typeof memoryStore>; connected?: boolean } = {}) {
  const app = createApex(memoryStore(), () => NOW);
  await app.init();
  const store = opts.store ?? memoryStore();
  const server = fakeServer(replies);
  const ai = createAssistant({ store, apex: app, fetch: server.fetch, timeouts: { chat: 50, action: 50 }, now: () => NOW });
  await ai.init();
  if (opts.connected !== false) await ai.connect('http://apex.test/', TOKEN);
  return { app, store, ai, ...server };
}

const reply = (message: string, extra: object = {}) => ({ body: { conversation_id: 'conv-1', message, tools_used: ['get_training_load', 'get_today_plan', 'propose_x'], action_required: false, action: null, ...extra } });

let logs: jest.SpiedFunction<typeof console.log>[] = [];
beforeEach(() => {
  logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => jest.spyOn(console, k).mockImplementation(() => undefined));
});
afterEach(() => {
  // the AI client never logs — no tokens, no athlete data, no messages
  for (const l of logs) expect(l).not.toHaveBeenCalled();
  logs.forEach((l) => l.mockRestore());
});

describe('chat', () => {
  it('sends to the APEX AI server with the bearer token, today’s date and the device’s data — and keeps the conversation id', async () => {
    const { ai, calls, app } = await setup([reply('Your load is moderate.'), reply('Legs.')]);
    expect(await ai.send('  How loaded am I?  ')).toBe(true);
    expect(calls[0]).toMatchObject({ url: 'http://apex.test/ai/chat', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
    expect(calls[0].body).toEqual({ message: 'How loaded am I?', mode: 'default', context: { today: '2026-10-07', athlete_data: app.getState().data } });
    expect(JSON.stringify(calls[0].body)).not.toContain(TOKEN);
    const [user, apexMsg] = ai.getState().messages as [UserMessage, ApexMessage];
    expect(user).toMatchObject({ role: 'user', text: 'How loaded am I?', status: 'sent' });
    expect(apexMsg).toMatchObject({ role: 'apex', text: 'Your load is moderate.', checked: ['training load', 'today’s plan'] });
    expect(ai.getState()).toMatchObject({ conversationId: 'conv-1', sending: false });
    await ai.send('And today?');
    expect(calls[1].body.conversation_id).toBe('conv-1');
  });

  it('one request at a time: a second send while waiting is refused', async () => {
    const { ai, calls } = await setup([reply('a')]);
    const [a, b] = await Promise.all([ai.send('one'), ai.send('two')]);
    expect([a, b]).toEqual([true, false]);
    expect(calls).toHaveLength(1);
  });

  it('refuses empty, too long, or unconnected sends without a request', async () => {
    const { ai, calls } = await setup();
    expect(await ai.send('   ')).toBe(false);
    expect(await ai.send('x'.repeat(MAX_MESSAGE + 1))).toBe(false);
    await ai.disconnect();
    expect(await ai.send('hi')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('maps every failure to plain words; read-only questions can be retried', async () => {
    const cases: [Reply, string, boolean][] = [
      ['offline', 'Couldn’t reach APEX AI. Check your connection and try again.', true],
      ['hang', 'APEX AI took too long to answer. Try again.', true],
      [{ status: 429, body: { error: { code: 'rate_limited' } } }, 'That’s a lot of questions in a short time. Try again in a few minutes.', true],
      [{ status: 400, body: { error: { code: 'invalid_request', detail: '$.context.today: not today' } } }, 'That message couldn’t be sent. Try rephrasing it.', false],
      [{ status: 502, body: { error: { code: 'model_error', message: 'internal detail' } } }, 'APEX AI is unavailable right now. Your training data isn’t affected.', true],
      [{ status: 200, raw: '<html>gateway</html>' }, 'APEX AI sent a reply this app couldn’t read. Try again.', true],
      [{ status: 200, body: { conversation_id: 'c', message: '' } }, 'APEX AI sent a reply this app couldn’t read. Try again.', true],
      [{ status: 200, body: { conversation_id: 'c', message: 'x', action_required: true, action: { id: 1 } } }, 'APEX AI sent a reply this app couldn’t read. Try again.', true],
    ];
    for (const [r, text, retry] of cases) {
      const { ai } = await setup([r]);
      expect(await ai.send('hi')).toBe(false);
      expect(ai.getState().messages).toEqual([expect.objectContaining({ role: 'user', status: 'failed', error: text, ...(retry ? { retry: true } : {}) })]);
      expect(JSON.stringify(ai.getState())).not.toMatch(/internal detail|\$\.context|gateway/);
    }
  });

  it('retry sends the same question again in the same conversation', async () => {
    const { ai, calls } = await setup([reply('first'), 'offline', reply('second')]);
    await ai.send('one');
    expect(await ai.send('two')).toBe(false);
    const failed = ai.getState().messages.find((m) => m.role === 'user' && m.status === 'failed')!;
    expect(await ai.retry(failed.id)).toBe(true);
    expect(calls[2].body).toMatchObject({ message: 'two', conversation_id: 'conv-1' });
    expect(ai.getState().messages.map((m) => (m.role === 'user' ? `${m.text}:${m.status}` : m.text))).toEqual(['one:sent', 'first', 'two:sent', 'second']);
  });

  it('a 401 asks the athlete to reconnect and stops sending', async () => {
    const { ai, calls } = await setup([{ status: 401, body: { error: { code: 'unauthorized' } } }]);
    await ai.send('hi');
    expect(ai.getState().authFailed).toBe(true);
    expect(await ai.send('again')).toBe(false);
    expect(calls).toHaveLength(1);
    await ai.connect('http://apex.test', `${TOKEN}-new`);
    expect(ai.getState().authFailed).toBe(false);
  });

  it('a new conversation clears only the conversation, and an answer for the old one is dropped', async () => {
    const { ai, app, calls } = await setup([reply('a'), 'hang']);
    await ai.send('one');
    const before = JSON.stringify(app.getState().data);
    const pending = ai.send('two');
    await ai.newConversation();
    expect(await pending).toBe(false);
    expect(ai.getState()).toMatchObject({ conversationId: null, messages: [], sending: false, connection: { url: 'http://apex.test' } });
    expect(JSON.stringify(app.getState().data)).toBe(before);
    await ai.send('three');
    expect(calls[2].body.conversation_id).toBeUndefined();
  });

  it('the answer mode is sent as the backend’s mode', async () => {
    const { ai, calls } = await setup();
    ai.setMode('deep');
    await ai.send('hi');
    expect(calls[0].body.mode).toBe('deep');
  });
});

describe('storage', () => {
  it('keeps a bounded conversation under its own key, apart from training data', async () => {
    const replies = Array.from({ length: 30 }, (_, i) => reply(`answer ${i} ${'x'.repeat(5000)}`));
    const { ai, store } = await setup(replies);
    for (let i = 0; i < 30; i++) await ai.send(`q${i}`);
    await ai.flush();
    const saved = JSON.parse(store.dump()[CONVERSATION_KEY]);
    expect(saved.messages).toHaveLength(40);
    expect(saved.messages.at(-1).text).toHaveLength(4000);
    expect(Object.keys(store.dump()).sort()).toEqual([CONNECTION_KEY, CONVERSATION_KEY]);
  });

  it('restores the conversation; unfinished sends become "not sent", unfinished confirms become confirmable again', async () => {
    const store = memoryStore({
      [CONVERSATION_KEY]: JSON.stringify({
        v: 1, conversationId: 'conv-9', mode: 'fast', messages: [
          { id: 'm1', role: 'user', text: 'Log it', at: NOW.toISOString(), status: 'sent' },
          { id: 'm2', role: 'apex', text: 'Confirm?', at: NOW.toISOString(), checked: [], action: { id: 'a1', type: 'log_basketball', summary: 's', arguments: { duration_min: 90 }, preview: [], expiresAt: '2026-10-07T18:05:00Z', state: 'confirming' } },
          { id: 'm3', role: 'user', text: 'half sent', at: NOW.toISOString(), status: 'sending' },
          { id: 'm4', role: 'robot', text: 'x', at: NOW.toISOString() },
        ],
      }),
    });
    const { ai } = await setup([], { store });
    expect(ai.getState()).toMatchObject({ conversationId: 'conv-9', mode: 'fast' });
    expect(ai.getState().messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect((ai.getState().messages[1] as ApexMessage).action!.state).toBe('pending');
    expect(ai.getState().messages[2]).toMatchObject({ status: 'failed', retry: true });
  });

  it('recovers from unreadable storage by starting clean', async () => {
    const store = memoryStore({ [CONVERSATION_KEY]: '{not json', [CONNECTION_KEY]: '42' });
    const { ai } = await setup([], { store, connected: false });
    expect(ai.getState()).toMatchObject({ ready: true, messages: [], connection: null });
    expect(store.dump()[CONVERSATION_KEY]).toBeUndefined();
  });

  it('validates the connection before saving it', async () => {
    const { ai } = await setup([], { connected: false });
    expect(await ai.connect('ftp://x', TOKEN)).toBe(false);
    expect(await ai.connect('http://apex.test', 'short')).toBe(false);
    expect(await ai.connect('http://apex.test', 'has spaces in it')).toBe(false);
    expect(ai.getState().connection).toBeNull();
  });
});
