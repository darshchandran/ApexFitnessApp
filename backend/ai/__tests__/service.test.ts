import { describe, expect, it } from '@jest/globals';
import { handleChat } from '../handler';
import { INSTRUCTIONS, PROMPT_VERSION } from '../prompts';
import { AIError } from '../schemas';
import { loadAIConfig } from '../config';
import type { AILogEvent } from '../security';
import { AIService, type ChatInput } from '../service';
import { callTool, fakeClient, post, res, say, TODAY, testActions, testDeps, testService, toolOutputs, trainedAthlete, type Body } from '../test-utils';

const chat = async (over: Partial<ChatInput> = {}): Promise<ChatInput> => ({
  userId: 'athlete_1', conversationId: 'c1', message: 'Why did you reduce today’s legs?', mode: 'default', data: await trainedAthlete(), today: TODAY, ...over,
});
const rejects = async (p: Promise<unknown>, code: string, category?: string) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(AIError);
  expect((e as AIError).code).toBe(code);
  if (category) expect((e as AIError).category).toBe(category);
};

describe('the Chat Completions tool loop', () => {
  it('a plain answer: one request with APEX instructions as the system message and the 14 tools', async () => {
    const { ai, bodies } = testService(() => say('Hi! Ask me about your training.'));
    const out = await ai.respond(await chat({ message: 'hello' }));
    expect(out).toEqual({ conversation_id: 'c1', message: 'Hi! Ask me about your training.', model: 'test-model', prompt_version: PROMPT_VERSION, tools_used: [], action_required: false, action: null, rounds: 0 });
    const b = bodies[0];
    expect(b).toMatchObject({ model: 'test-model', tool_choice: 'auto', max_completion_tokens: 2000 });
    expect(b.messages[0]).toEqual({ role: 'system', content: expect.stringContaining('source of truth') });
    // explanation contracts (audit 6B): quote the engine's recommendation; no catalogue entries as history
    expect(INSTRUCTIONS).toMatch(/quote engine_recommendation[\s\S]*never change, soften or contradict it/);
    expect(INSTRUCTIONS).toMatch(/"no_history"[\s\S]*never present catalogue exercises/);
    expect(INSTRUCTIONS).toMatch(/PRs, measurements and profile changes are entered by the athlete in the app — never offer to log them yourself/); // seen live: "I can log it"
    expect(b.tools).toHaveLength(14);
    expect(b.messages.slice(1)).toEqual([{ role: 'user', content: 'hello' }]);
    // the test config is OpenAI: nothing stored there, an opaque per-athlete id (Groq takes neither — see below)
    expect(b).toMatchObject({ store: false, safety_identifier: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(JSON.stringify(b)).not.toContain('athlete_1'); // neither the user id nor athlete data goes to the model unasked
    expect(JSON.stringify(b)).not.toContain('Smith Machine Squat');
  });

  it('tool call → tool result → final answer, explaining with the real decision record', async () => {
    const { ai, bodies } = testService((_b, n) => (n === 0 ? res(callTool('get_current_adaptation')) : say('Legs was cut because of this morning’s basketball.')));
    const out = await ai.respond(await chat());
    expect(out).toMatchObject({ message: 'Legs was cut because of this morning’s basketball.', tools_used: ['get_current_adaptation'], rounds: 1 });
    const second = bodies[1];
    expect(second.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(second.messages[2]).toEqual({ role: 'assistant', content: null, tool_calls: [callTool('get_current_adaptation')] });
    expect(second.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_get_current_adaptation_1' });
    const [adaptation] = toolOutputs(second);
    expect(adaptation.sessions[0]).toMatchObject({ template: 'Legs', outcome: expect.not.stringMatching(/^normal$/) });
    expect(adaptation.sessions[0].reasons.join(' ')).toMatch(/basketball/i);
  });

  it('several tool calls in one response and across rounds', async () => {
    const { ai, bodies, logs } = testService((_b, n) =>
      n === 0 ? res(callTool('get_today_plan'), callTool('get_current_adaptation'))
        : n === 1 ? res(callTool('get_recent_sessions', { days: 3 }), callTool('get_training_load'))
          : say('Here is why.'));
    const out = await ai.respond(await chat());
    expect(out.tools_used).toEqual(['get_today_plan', 'get_current_adaptation', 'get_recent_sessions', 'get_training_load']);
    expect(out.rounds).toBe(2);
    expect(toolOutputs(bodies[2])).toHaveLength(4);
    expect(logs.filter((l) => l.event === 'ai.tool').map((l) => l.event === 'ai.tool' && [l.tool, l.ok])).toEqual([
      ['get_today_plan', true], ['get_current_adaptation', true], ['get_recent_sessions', true], ['get_training_load', true],
    ]);
  });

  it('a failing tool call is returned to the model as an error, and the model can recover', async () => {
    const { ai, bodies, logs } = testService((_b, n) =>
      n === 0 ? res(callTool('get_recent_sessions', { days: 400 }), callTool('delete_history', {}), { ...callTool('get_prs', {}, 3), function: { name: 'get_prs', arguments: '{oops' } })
        : n === 1 ? res(callTool('get_recent_sessions', { days: 28 }))
          : say('Over the last 4 weeks you logged 2 sessions.'));
    const out = await ai.respond(await chat({ message: 'what did I do this month?' }));
    expect(out.message).toMatch(/2 sessions/);
    expect(toolOutputs(bodies[1])).toEqual([
      { error: 'invalid_arguments', detail: '$.days: above 28' },
      { error: 'unknown_tool' },
      { error: 'invalid_arguments', detail: 'arguments are not valid JSON' },
    ]);
    expect(out.tools_used).toEqual(['get_recent_sessions', 'get_prs']); // unknown names are never recorded
    expect(logs).toContainEqual({ event: 'ai.tool', tool: 'unknown', ok: false, error: 'unknown_tool', ms: expect.any(Number) });
  });

  it('too many calls in one response: the extra ones are refused, not run', async () => {
    const many = Array.from({ length: 8 }, (_, k) => callTool('get_readiness', {}, k));
    const { ai, bodies } = testService((_b, n) => (n === 0 ? res(...many) : say('ok')));
    await ai.respond(await chat());
    expect(toolOutputs(bodies[1]).map((o) => o.error ?? 'ran')).toEqual(['ran', 'ran', 'ran', 'ran', 'ran', 'ran', 'call_limit', 'call_limit']);
  });

  it('stops a model that keeps asking for tools after the round limit', async () => {
    const { ai, bodies } = testService(() => res(callTool('get_readiness')), { maxToolRounds: 3 });
    await rejects(ai.respond(await chat()), 'tool_limit');
    expect(bodies).toHaveLength(4); // 3 tool rounds, then the 4th tool request is refused
  });
});

describe('failures stay contained', () => {
  it('model and API failures become safe error codes', async () => {
    const fail = (e: object) => () => Promise.reject(Object.assign(new Error('upstream detail'), e));
    await rejects(testService(fail({ status: 401 })).ai.respond(await chat()), 'ai_unavailable', 'upstream_auth');
    await rejects(testService(fail({ status: 429 })).ai.respond(await chat()), 'ai_busy', 'upstream_rate_limit');
    await rejects(testService(fail({ status: 429, code: 'insufficient_quota' })).ai.respond(await chat()), 'ai_unavailable', 'upstream_quota');
    await rejects(testService(fail({ status: 429, code: 'credit_balance_exhausted' })).ai.respond(await chat()), 'ai_unavailable', 'upstream_quota'); // seen live
    await rejects(testService(fail({ status: 503 })).ai.respond(await chat()), 'ai_unavailable', 'upstream_unavailable');
    await rejects(testService(fail({ status: 400 })).ai.respond(await chat()), 'model_error', 'upstream_rejected');
    await rejects(testService(fail({ name: 'APIConnectionError' })).ai.respond(await chat()), 'ai_unavailable', 'upstream_network');
    await rejects(testService(fail({ name: 'APIConnectionTimeoutError' })).ai.respond(await chat()), 'timeout');
    const { ai, logs } = testService(fail({ status: 500 }));
    await rejects(ai.respond(await chat()), 'ai_unavailable');
    const down = { event: 'ai.model_error', category: 'upstream_unavailable', model: 'test-model', upstream: { status: 500 } };
    expect(logs).toEqual([down, down]); // tried once more, then refused
    // a 429 is logged with the provider's error identifier and the account's published limits — never its message
    const limited = testService(fail({ status: 429, code: 'rate_limit_exceeded', message: 'Rate limit reached in organization org-secret', headers: new Headers({ 'x-ratelimit-limit-tokens': '30000', 'x-ratelimit-limit-requests': '500' }) }));
    await rejects(limited.ai.respond(await chat()), 'ai_busy', 'upstream_rate_limit');
    expect(limited.logs).toEqual([{ event: 'ai.model_error', category: 'upstream_rate_limit', model: 'test-model', upstream: { status: 429, code: 'rate_limit_exceeded', limitRequests: '500', limitTokens: '30000' } }]);
    expect(JSON.stringify(limited.logs)).not.toMatch(/org-secret|upstream detail/);
  });

  it('times out on a hung model call and aborts it', async () => {
    let aborted = false;
    const hang = (_b: Body, _n: number, opts?: { signal?: AbortSignal }) => new Promise<never>((_, reject) => {
      opts?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    });
    const { ai } = testService(hang, { timeoutMs: 30 });
    await rejects(ai.respond(await chat()), 'timeout');
    expect(aborted).toBe(true);
  });

  it('malformed model output is refused, not guessed at', async () => {
    const cases = [
      () => ({ id: 'r', choices: null }) as never,
      () => ({ id: 'r', choices: [] }) as never,
      () => res(),
      () => say('', 'length'),
      () => say('   '),
      () => res({ id: 7, type: 'function', function: { name: 'get_readiness', arguments: {} } }),
      () => res(callTool('get_readiness'), { type: 'mystery_item' }),
    ];
    for (const script of cases) await rejects(testService(script).ai.respond(await chat()), 'model_error');
  });

  it('an AI outage never touches the athlete’s data', async () => {
    const data = await trainedAthlete();
    const before = JSON.stringify(data);
    const { deps } = testDeps(() => Promise.reject(Object.assign(new Error('down'), { status: 503 })));
    const r = await handleChat(post({ message: 'hi', context: { today: TODAY, athlete_data: data } }), deps);
    expect(r.status).toBe(503);
    expect(JSON.stringify(data)).toBe(before);
  });

  it('end to end through the endpoint: timeout and tool limit map to 504 and 502', async () => {
    const hung = testDeps((_b, _n, opts) => new Promise<never>((_, reject) => opts?.signal?.addEventListener('abort', () => reject(new Error('x')))), { limits: { timeoutMs: 20 } });
    expect((await handleChat(post({ message: 'hi' }), hung.deps)).status).toBe(504);
    const loop = testDeps(() => res(callTool('get_readiness')), { limits: { maxToolRounds: 2 } });
    const r = await handleChat(post({ message: 'hi' }), loop.deps);
    expect(r.status).toBe(502);
    expect((await r.json()).error.code).toBe('tool_limit');
  });
});

describe('conversation memory and actions', () => {
  it('follow-ups use the conversation the device sends — text only — and nothing is remembered between requests', async () => {
    const { ai, bodies } = testService((_b, n) => (n === 0 ? res(callTool('get_training_load')) : say(`answer ${n}`)));
    await ai.respond(await chat({ message: 'how loaded am I?' }));
    await ai.respond(await chat({ message: 'and tomorrow?' }));
    expect(bodies[2].messages.slice(1)).toEqual([{ role: 'user', content: 'and tomorrow?' }]); // the server kept nothing
    await ai.respond(await chat({ message: 'and tomorrow?', history: [{ role: 'user', content: 'how loaded am I?' }, { role: 'assistant', content: 'answer 1' }] }));
    expect(bodies[3].messages.slice(1)).toEqual([{ role: 'user', content: 'how loaded am I?' }, { role: 'assistant', content: 'answer 1' }, { role: 'user', content: 'and tomorrow?' }]);
    expect(bodies[3].messages.some((m) => m.role === 'tool')).toBe(false); // earlier tool data is never carried over
  });

  it('history is checked at the door: roles, content, count, size — and never echoed back', async () => {
    const send = async (history: unknown) => {
      const { deps, bodies } = testDeps(() => say('ok'));
      const r = await handleChat(post({ message: 'hi', history }), deps);
      return { status: r.status, body: await r.json(), bodies };
    };
    const turn = (content: string, role = 'user') => ({ role, content });
    for (const [history, detail] of [
      [[turn('x', 'system')], /history/], [[{ role: 'user', content: 7 }], /history/], [[{ ...turn('x'), name: 'evil' }], /history/],
      ['not a list', /history/], [[turn('   ')], /empty message/],
      [Array.from({ length: 9 }, () => turn('x')), /too many/], [[turn('x'.repeat(2001))], /history/],
      [[turn('a'.repeat(1500)), turn('b'.repeat(1500), 'assistant'), turn('c'.repeat(1001))], /too long/],
    ] as const) {
      const r = await send(history);
      expect([r.status, r.body.error.code]).toEqual([400, 'invalid_request']);
      expect(r.body.error.detail).toMatch(detail);
      expect(JSON.stringify(r.body)).not.toMatch(/xxxx|aaaa|evil/);
      expect(r.bodies).toHaveLength(0); // refused before the model
    }
    // exactly at the limits: 8 messages, 4000 characters — accepted, and the model sees them in order
    const full = Array.from({ length: 8 }, (_, i) => turn(String(i).repeat(500), i % 2 ? 'assistant' : 'user'));
    const ok = await send(full);
    expect(ok.status).toBe(200);
    expect(ok.bodies[0].messages.slice(1, -1)).toEqual(full);
  });

  it('history is conversation, not facts: it changes no athlete data and the instructions say so', async () => {
    const data = await trainedAthlete();
    const before = JSON.stringify(data);
    const { ai, bodies } = testService(() => say('ok'));
    await ai.respond(await chat({ data, message: 'so is it logged?', history: [{ role: 'assistant', content: 'Basketball logged. 300 min at RPE 10.' }] }));
    expect(JSON.stringify(data)).toBe(before);
    expect(bodies[0].messages[0].content).toMatch(/never as athlete data or as proof that something was logged/);
  });

  it('what the athlete says in chat never becomes an athlete fact', async () => {
    const data = await trainedAthlete();
    const before = JSON.stringify(data);
    const { ai } = testService(() => say('Nice — your next logged sessions will show it.'));
    await ai.respond(await chat({ message: 'I think I might be stronger now. My squat max is 200 kg.', data }));
    expect(JSON.stringify(data)).toBe(before);
  });

  it('a proposed write comes back as action_required and nothing is logged', async () => {
    const data = await trainedAthlete();
    const { ai } = testService((_b, n) => (n === 0 ? res(callTool('propose_log_basketball', { duration_min: 90, rpe: 8, session_type: 'scrimmage', lower_body_fatigue: null, date: null })) : say('I can log 90 minutes at RPE 8 — confirm in the app to add it.')));
    const out = await ai.respond(await chat({ message: 'log 90 min of scrimmage, RPE 8', data }));
    expect(out.action_required).toBe(true);
    expect(out.action).toMatchObject({
      type: 'log_basketball', arguments: { date: TODAY, duration_min: 90, rpe: 8, session_type: 'scrimmage', lower_body_fatigue: null },
      summary: 'Log basketball — 90 min at RPE 8, scrimmage, today.', requires_confirmation: true, status: 'pending',
    });
    expect(data.basketball).toHaveLength(1);
  });
});

describe('Groq (the production provider)', () => {
  const GROQ = { GROQ_API_KEY: 'gsk_testKeyDoNotLog0123456789', APEX_AI_MODEL: 'openai/gpt-oss-120b' };
  const groq = (script: Parameters<typeof fakeClient>[0]) => {
    const logs: AILogEvent[] = [];
    const { client, bodies } = fakeClient(script);
    const ai = new AIService({ client, config: loadAIConfig(GROQ), logger: (e) => logs.push(e), actions: testActions() });
    return { ai, bodies, logs };
  };
  const fail = (e: object) => () => Promise.reject(Object.assign(new Error('Rate limit reached for model in organization org_SECRET: Limit 8000, Requested 9000'), e));

  it("talks to Groq's OpenAI-compatible endpoint — never to OpenAI — with nothing OpenAI-only in the request", async () => {
    expect(loadAIConfig(GROQ)).toMatchObject({ provider: 'groq', baseURL: 'https://api.groq.com/openai/v1', apiKey: GROQ.GROQ_API_KEY });
    // an OpenAI key still configured changes nothing: Groq is chosen, there is no fallback
    expect(loadAIConfig({ ...GROQ, OPENAI_API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwxyz012345' })).toMatchObject({ provider: 'groq', baseURL: 'https://api.groq.com/openai/v1' });
    const { ai, bodies } = groq(() => say('Hi.'));
    await ai.respond(await chat());
    expect(bodies[0]).toMatchObject({ model: 'openai/gpt-oss-120b', tool_choice: 'auto', max_completion_tokens: 2000, reasoning_effort: 'low' });
    expect(bodies[0]).not.toHaveProperty('store');
    expect(bodies[0]).not.toHaveProperty('safety_identifier');
    expect(bodies[0].tools?.[0]).toMatchObject({ type: 'function', function: { name: expect.any(String) } });
  });

  it('free-tier rate limits: "busy, try again" with the wait Groq gives — nothing from its message is logged or returned', async () => {
    const limited = groq(fail({ status: 429, code: 'rate_limit_exceeded', headers: new Headers({ 'retry-after': '23', 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-limit-requests': '1000' }) }));
    const e = (await limited.ai.respond(await chat()).catch((x: unknown) => x)) as AIError;
    expect([e.code, e.category, e.retryAfter]).toEqual(['ai_busy', 'upstream_rate_limit', 23]);
    expect(limited.logs).toEqual([{ event: 'ai.model_error', category: 'upstream_rate_limit', model: 'openai/gpt-oss-120b', upstream: { status: 429, code: 'rate_limit_exceeded', limitRequests: '1000', limitTokens: '8000' } }]);
    expect(JSON.stringify(limited.logs)).not.toMatch(/org_SECRET|Rate limit reached|gsk_/);
    await rejects(groq(fail({ status: 413 })).ai.respond(await chat()), 'ai_unavailable', 'upstream_request_too_large');
    await rejects(groq(fail({ status: 498 })).ai.respond(await chat()), 'ai_unavailable', 'upstream_unavailable');
  });

  it('a tool call Groq could not parse (tool_use_failed) is sampled once more, then refused', async () => {
    const once = groq((_b, n) => (n === 0 ? Promise.reject(Object.assign(new Error('Failed to call a function'), { status: 400, code: 'tool_use_failed' })) : say('Recovered.')));
    expect((await once.ai.respond(await chat())).message).toBe('Recovered.');
    expect(once.bodies).toHaveLength(2);
    const always = groq(fail({ status: 400, code: 'tool_use_failed' }));
    await rejects(always.ai.respond(await chat()), 'model_error', 'upstream_tool_call_failed');
    expect(always.logs.filter((l) => l.event === 'ai.model_error')).toHaveLength(2);
  });

  it('one retry when it can help within the deadline: a short rate limit, a provider hiccup — never a long wait', async () => {
    const limited = (wait: string) => Object.assign(new Error('x'), { status: 429, code: 'rate_limit_exceeded', headers: new Headers({ 'retry-after': wait }) });
    const short = groq((_b, n) => (n === 0 ? Promise.reject(limited('1')) : say('After a short wait.')));
    expect((await short.ai.respond(await chat())).message).toBe('After a short wait.');
    const long = groq(() => Promise.reject(limited('40')));
    const t0 = Date.now();
    await rejects(long.ai.respond(await chat()), 'ai_busy', 'upstream_rate_limit');
    expect([long.bodies.length, Date.now() - t0 < 2000]).toEqual([1, true]); // no 40 s wait inside the request
    const hiccup = groq((_b, n) => (n === 0 ? Promise.reject(Object.assign(new Error('x'), { status: 503 })) : say('Back.')));
    expect((await hiccup.ai.respond(await chat())).message).toBe('Back.');
    const down = groq(fail({ status: 503 }));
    await rejects(down.ai.respond(await chat()), 'ai_unavailable', 'upstream_unavailable');
    expect(down.bodies).toHaveLength(2); // once more, then a safe error
  });

  it('over the endpoint: a throttled provider answers 429 ai_busy with Retry-After, in plain words', async () => {
    const { deps } = testDeps(fail({ status: 429, code: 'rate_limit_exceeded', headers: new Headers({ 'retry-after': '7' }) }));
    const r = await handleChat(post({ message: 'hi' }), deps);
    expect([r.status, r.headers.get('retry-after')]).toEqual([429, '7']);
    const body = await r.json();
    expect(body.error).toEqual({ code: 'ai_busy', message: expect.stringMatching(/busy right now.*not affected/) });
    expect(JSON.stringify(body)).not.toMatch(/org_SECRET|Rate limit reached/);
  });
});

