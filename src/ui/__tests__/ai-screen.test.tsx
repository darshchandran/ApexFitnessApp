import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Text, TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { memoryStore } from '../../data/store';
import { CONVERSATION_KEY, createAssistant } from '../../services/ai';
import { createApex } from '../../services/apex';
import { ApexAI, STARTERS } from '../ai';

const NOW = new Date(2026, 9, 7, 18);
const TODAY = '2026-10-07';
const metrics = { frame: { x: 0, y: 0, width: 375, height: 812 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
type Reply = { status?: number; body: unknown; wait?: Promise<void> } | 'offline' | 'hang';

async function setup(replies: Reply[] = [], opts: { connected?: boolean; stored?: object; allowServerEntry?: boolean } = {}) {
  const app = createApex(memoryStore(), () => NOW);
  await app.init();
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = jest.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.startsWith('/ai/auth/')) {
      return new Response(JSON.stringify({ athlete_id: 'ath_ui', access_token: 'v1.ui.token', access_expires_at: new Date(NOW.getTime() + 900_000).toISOString(), refresh_token: `rt_${'u'.repeat(43)}`, refresh_expires_at: new Date(NOW.getTime() + 86_400_000).toISOString() }), { status: 201 });
    }
    calls.push({ path, body: JSON.parse(String(init.body)) });
    const r = replies.shift() ?? { body: { conversation_id: 'conv-1', message: 'ok' } };
    if (r === 'offline') throw new TypeError('Network request failed');
    if (r === 'hang') return new Promise<Response>(() => undefined);
    await r.wait;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  const store = memoryStore(opts.stored ? { [CONVERSATION_KEY]: JSON.stringify(opts.stored) } : {});
  const ai = createAssistant({ store, apex: app, fetch, now: () => NOW, timeouts: { chat: 300, action: 300 } });
  await ai.init();
  if (opts.connected !== false) await ai.connect('http://apex.test');
  let r!: ReactTestRenderer;
  await act(async () => {
    // unmounted after each test: a card's expiry timer must not outlive it
    r = create(<SafeAreaProvider initialMetrics={metrics}><ApexAI assistant={ai} today={TODAY} onBack={() => undefined} allowServerEntry={opts.allowServerEntry} /></SafeAreaProvider>);
  });
  mounted.push(r);
  return { r, ai, app, calls };
}

const mounted: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => mounted.splice(0).forEach((m) => m.unmount()));
});

const textOf = (r: ReactTestRenderer) =>
  r.root.findAllByType(Text).map((t) => ([] as unknown[]).concat(t.props.children).filter((c) => typeof c === 'string' || typeof c === 'number').join('')).join('\n');
const pressable = (r: ReactTestRenderer, label: string) => r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0] as ReactTestInstance | undefined;
const press = (n: ReactTestInstance | undefined) => act(async () => { n!.props.onPress(); });
const composer = (r: ReactTestRenderer) => r.root.findAllByType(TextInput).find((t) => t.props.accessibilityLabel === 'Message APEX AI')!;
const type = (r: ReactTestRenderer, text: string) => act(async () => { composer(r).props.onChangeText(text); });
const answer = (message: string, extra: object = {}) => ({ body: { conversation_id: 'conv-1', message, tools_used: ['get_training_load'], action_required: false, action: null, ...extra } });
const ACTION = {
  id: '0f8c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f', type: 'log_basketball', summary: 'Log basketball — 90 min at RPE 8, today.',
  arguments: { date: TODAY, duration_min: 90, rpe: 8, session_type: null, lower_body_fatigue: null },
  preview: ['Basketball 90 min at RPE 8 on 2026-10-07', 'Legs: 11 sets · Adapted', 'Today’s load: 0 → 720 (extreme)'],
  requires_confirmation: true, status: 'pending', created_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
};
const proposal = answer('I can log that. Confirm below.', { tools_used: ['propose_log_basketball'], action_required: true, action: ACTION });
const executed = {
  body: {
    action: { ...ACTION, status: 'executed' }, message: 'Basketball logged.',
    result: { success: true, action_id: ACTION.id, action_type: 'log_basketball', affected_entities: [], timestamp: NOW.toISOString(),
      result: { changes: { basketball: [{ id: 'bb_1', sport: 'basketball', date: TODAY, loggedAt: NOW.toISOString(), durationMin: 90, rpe: 8 }], instances: [] } } },
  },
};

describe('APEX AI screen', () => {
  it('no server in the build: production builds say so; development builds ask for a server address — never a token', async () => {
    const prod = await setup([], { connected: false });
    expect(textOf(prod.r)).toContain('APEX AI isn’t available in this version of the app.');
    expect(prod.r.root.findAllByType(TextInput)).toHaveLength(0);
    const dev = await setup([], { connected: false, allowServerEntry: true });
    expect(textOf(dev.r)).toContain('APEX AI server');
    expect(dev.r.root.findAllByType(TextInput).map((t) => t.props.accessibilityLabel)).toEqual(['APEX AI server address']);
  });

  it('empty: title, starter prompts; a starter sends right away and the starters make way for the conversation', async () => {
    const { r, calls } = await setup([answer('Recovering well — load is low.')]);
    const t = textOf(r);
    expect(t).toContain('APEX AI');
    expect(t).toContain('Train · Adapt · Perform');
    for (const s of STARTERS) expect(pressable(r, `Ask: ${s}`)).toBeDefined();
    await press(pressable(r, `Ask: ${STARTERS[0]}`));
    expect(calls[0]).toMatchObject({ path: '/ai/chat', body: { message: STARTERS[0] } });
    expect(textOf(r)).toContain('Recovering well — load is low.');
    expect(textOf(r)).toContain('Checked training load');
    expect(pressable(r, `Ask: ${STARTERS[1]}`)).toBeUndefined();
  });

  it('restores an existing conversation and renders markdown as plain readable text', async () => {
    const { r } = await setup([], {
      stored: { v: 1, conversationId: 'conv-7', mode: 'default', messages: [
        { id: 'a', role: 'user', text: 'What did I do last?', at: NOW.toISOString(), status: 'sent' },
        { id: 'b', role: 'apex', text: '**Pull** on Monday:\n- 3 exercises\n- 9 sets', at: NOW.toISOString(), checked: ['workout history'] },
      ] },
    });
    const t = textOf(r);
    expect(t).toContain('What did I do last?');
    expect(t).toContain('Pull on Monday:');
    expect(t).toContain('3 exercises');
    expect(t).not.toContain('**');
    expect(t).toContain('Today · ');
  });

  it('loading: shows progress, keeps the text, and can’t send twice', async () => {
    const { r, calls } = await setup(['hang']);
    await type(r, 'How loaded am I?');
    await press(pressable(r, 'Send'));
    expect(textOf(r)).toContain('Checking your training…');
    expect(pressable(r, 'Send')!.props.disabled).toBe(true);
    expect(composer(r).props.editable).toBe(false);
    expect(composer(r).props.value).toBe('How loaded am I?');
    await press(pressable(r, 'Send'));
    expect(calls).toHaveLength(1);
  });

  it('error with Retry; the composer clears only after a successful send', async () => {
    const { r } = await setup(['offline', answer('Load is moderate.')]);
    await type(r, 'How loaded am I?');
    await press(pressable(r, 'Send'));
    expect(textOf(r)).toContain('Couldn’t reach APEX AI. Check your connection and try again.');
    expect(composer(r).props.value).toBe('How loaded am I?');
    await press(pressable(r, 'Retry sending this message'));
    expect(textOf(r)).toContain('Load is moderate.');
    expect(composer(r).props.value).toBe('');
  });

  it('new conversation clears the conversation only', async () => {
    const { r, app } = await setup([answer('Hi.')]);
    await press(pressable(r, `Ask: ${STARTERS[1]}`));
    const data = JSON.stringify(app.getState().data);
    await press(pressable(r, 'New conversation'));
    expect(textOf(r)).not.toContain('Hi.');
    expect(pressable(r, `Ask: ${STARTERS[1]}`)).toBeDefined();
    expect(JSON.stringify(app.getState().data)).toBe(data);
  });

  it('an action proposal renders as a card — no raw JSON — and Confirm runs once and stores the result', async () => {
    let release!: () => void;
    const held = { ...executed, wait: new Promise<void>((res) => { release = res; }) };
    const { r, calls, app } = await setup([proposal, held]);
    await type(r, 'Log basketball for 90 minutes at RPE 8.');
    await press(pressable(r, 'Send'));
    const t = textOf(r);
    for (const s of ['Log basketball', '90 min · RPE 8', 'Today', 'This adds a basketball session to your training history.', 'What will change', 'Basketball 90 min at RPE 8 today', 'Legs: 11 sets · Adapted', 'Today’s load: 0 → 720 (very high)']) expect(t).toContain(s);
    expect(t).not.toMatch(/duration_min|lower_body_fatigue|\{|0f8c1d2e/);
    expect(pressable(r, 'Cancel: Log basketball')).toBeDefined();

    await press(pressable(r, 'Confirm: Log basketball, 90 min · RPE 8'));
    // in flight: "Confirming…", both buttons disabled, a second tap sends nothing
    expect(textOf(r)).toContain('CONFIRMING…');
    expect(pressable(r, 'Confirm: Log basketball, 90 min · RPE 8')!.props.disabled).toBe(true);
    expect(pressable(r, 'Cancel: Log basketball')!.props.disabled).toBe(true);
    await press(pressable(r, 'Confirm: Log basketball, 90 min · RPE 8'));
    expect(calls.filter((c) => c.path.endsWith('/confirm'))).toHaveLength(1);
    expect(app.getState().data.basketball).toHaveLength(0);

    await act(async () => { release(); await held.wait; });
    expect(calls.at(-1)).toMatchObject({ path: `/ai/actions/${ACTION.id}/confirm`, body: { arguments: ACTION.arguments, context: { today: TODAY } } });
    expect(textOf(r)).toContain('Basketball session logged.');
    expect(textOf(r)).toContain('What changed');
    expect(app.getState().data.basketball.map((b) => b.id)).toEqual(['bb_1']);
    expect(pressable(r, 'Confirm: Log basketball, 90 min · RPE 8')).toBeUndefined();
  });

  it('Cancel calls the cancel endpoint and the card resolves without touching data', async () => {
    const { r, calls, app } = await setup([proposal, { body: { action: { ...ACTION, status: 'cancelled' } } }]);
    await press(pressable(r, `Ask: ${STARTERS[0]}`));
    const data = JSON.stringify(app.getState().data);
    await press(pressable(r, 'Cancel: Log basketball'));
    expect(calls.at(-1)!.path).toBe(`/ai/actions/${ACTION.id}/cancel`);
    expect(textOf(r)).toContain('Cancelled — nothing was changed.');
    expect(pressable(r, 'Confirm: Log basketball, 90 min · RPE 8')).toBeUndefined();
    expect(JSON.stringify(app.getState().data)).toBe(data);
  });

  it('an expired proposal flips to expired by itself and can’t be confirmed', async () => {
    const soon = { ...proposal, body: { ...proposal.body, action: { ...ACTION, expires_at: new Date(Date.now() + 30).toISOString() } } };
    const { r, calls } = await setup([soon]);
    await press(pressable(r, `Ask: ${STARTERS[0]}`));
    await act(async () => { await new Promise((res) => setTimeout(res, 150)); });
    expect(textOf(r)).toContain('This action has expired. Ask APEX AI again if you still want to do this.');
    expect(pressable(r, 'Confirm: Log basketball, 90 min · RPE 8')).toBeUndefined();
    expect(calls.filter((c) => c.path.endsWith('/confirm'))).toHaveLength(0);
  });

  it('a failed confirmation shows why, and nothing is applied', async () => {
    const failed = { status: 422, body: { error: { code: 'action_failed', message: 'x' }, result: { success: false, error: { code: 'action_failed', message: 'Today’s plan changed since this was proposed — ask again.' } } } };
    const { r, app } = await setup([proposal, failed]);
    await press(pressable(r, `Ask: ${STARTERS[0]}`));
    await press(pressable(r, 'Confirm: Log basketball, 90 min · RPE 8'));
    expect(textOf(r)).toContain('Nothing was changed. Today’s plan changed since this was proposed — ask again.');
    expect(app.getState().data.basketball).toHaveLength(0);
  });
});
