import { describe, expect, it } from '@jest/globals';
import { handleChat } from '../handler';
import { PROMPT_VERSION } from '../prompts';
import { AIError } from '../schemas';
import { ConversationStore, type ChatInput } from '../service';
import { callTool, post, res, say, TODAY, testDeps, testService, toolOutputs, trainedAthlete, type Body } from '../test-utils';

const chat = async (over: Partial<ChatInput> = {}): Promise<ChatInput> => ({
  userId: 'athlete_1', conversationId: 'c1', message: 'Why did you reduce today’s legs?', mode: 'default', data: await trainedAthlete(), today: TODAY, ...over,
});
const rejects = async (p: Promise<unknown>, code: string, category?: string) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(AIError);
  expect((e as AIError).code).toBe(code);
  if (category) expect((e as AIError).category).toBe(category);
};

describe('the Responses API loop', () => {
  it('a plain answer: one request with APEX instructions, strict tools, no storage at OpenAI', async () => {
    const { ai, bodies } = testService(() => say('Hi! Ask me about your training.'));
    const out = await ai.respond(await chat({ message: 'hello' }));
    expect(out).toEqual({ conversation_id: 'c1', message: 'Hi! Ask me about your training.', model: 'test-model', prompt_version: PROMPT_VERSION, tools_used: [], action_required: false, action: null, rounds: 0 });
    const b = bodies[0];
    expect(b).toMatchObject({ model: 'test-model', store: false, tool_choice: 'auto', parallel_tool_calls: true, max_output_tokens: 2000 });
    expect(b.instructions).toContain('source of truth');
    expect(b.tools).toHaveLength(14);
    expect(b.input).toEqual([{ role: 'user', content: 'hello' }]);
    expect(b.safety_identifier).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(b)).not.toContain('athlete_1'); // neither the user id nor athlete data goes to the model unasked
    expect(JSON.stringify(b)).not.toContain('Smith Machine Squat');
  });

  it('tool call → tool result → final answer, explaining with the real decision record', async () => {
    const { ai, bodies } = testService((_b, n) => (n === 0 ? res(callTool('get_current_adaptation')) : say('Legs was cut because of this morning’s basketball.')));
    const out = await ai.respond(await chat());
    expect(out).toMatchObject({ message: 'Legs was cut because of this morning’s basketball.', tools_used: ['get_current_adaptation'], rounds: 1 });
    const second = bodies[1];
    expect(second.input.map((i) => i.type ?? i.role)).toEqual(['user', 'function_call', 'function_call_output']);
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
      n === 0 ? res(callTool('get_recent_sessions', { days: 400 }), callTool('delete_history', {}), { ...callTool('get_prs', {}, 3), arguments: '{oops' })
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
    await rejects(testService(fail({ status: 429 })).ai.respond(await chat()), 'ai_unavailable', 'upstream_rate_limit');
    await rejects(testService(fail({ status: 429, code: 'insufficient_quota' })).ai.respond(await chat()), 'ai_unavailable', 'upstream_quota');
    await rejects(testService(fail({ status: 503 })).ai.respond(await chat()), 'ai_unavailable', 'upstream_unavailable');
    await rejects(testService(fail({ status: 400 })).ai.respond(await chat()), 'model_error', 'upstream_rejected');
    await rejects(testService(fail({ name: 'APIConnectionError' })).ai.respond(await chat()), 'ai_unavailable', 'upstream_network');
    await rejects(testService(fail({ name: 'APIConnectionTimeoutError' })).ai.respond(await chat()), 'timeout');
    const { ai, logs } = testService(fail({ status: 500 }));
    await rejects(ai.respond(await chat()), 'ai_unavailable');
    expect(logs).toEqual([{ event: 'ai.model_error', category: 'upstream_unavailable', model: 'test-model' }]);
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
      () => ({ id: 'r', status: 'completed', output: null }) as never,
      () => res(),
      () => ({ ...say(''), status: 'incomplete' }) as never,
      () => ({ ...say('half'), status: 'failed' }) as never,
      () => res({ type: 'function_call', call_id: 7, name: 'get_readiness', arguments: {} }),
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
  it('continues a conversation with text turns only — no tool data is remembered', async () => {
    const { ai, bodies } = testService((_b, n) => (n === 0 ? res(callTool('get_training_load')) : say(`answer ${n}`)));
    await ai.respond(await chat({ message: 'how loaded am I?' }));
    await ai.respond(await chat({ message: 'and tomorrow?' }));
    expect(bodies[2].input).toEqual([
      { role: 'user', content: 'how loaded am I?' },
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'and tomorrow?' },
    ]);
  });

  it('keeps a bounded window of turns that expires', () => {
    const store = new ConversationStore(4, 1000);
    for (let i = 0; i < 5; i++) store.add('u', 'c', [{ role: 'user', content: `q${i}` }, { role: 'assistant', content: `a${i}` }], i);
    expect(store.get('u', 'c', 10).map((t) => t.content)).toEqual(['q3', 'a3', 'q4', 'a4']);
    expect(store.get('u', 'c', 5000)).toEqual([]);
    expect(store.get('someone_else', 'c', 10)).toEqual([]);
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
