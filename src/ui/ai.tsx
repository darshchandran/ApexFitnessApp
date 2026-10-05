// APEX AI: a conversation about the athlete's own training, and confirmable actions — in the app's
// own visual language. Everything shown comes from the APEX AI backend; nothing here invents answers.
import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ISODate } from '@/domain/types';
import { toISODate } from '@/domain/util';
import { MAX_MESSAGE, type ApexMessage, type Assistant, type Mode, type ProposedAction, type UserMessage } from '@/services/ai';
import { BottomSheet } from './BottomSheet';
import { dayMonth } from './format';
import { Icon } from './Icon';
import { Button, IconButton, tap, Txt } from './primitives';
import { bandLabel, C, F, GUTTER, R, S, TOUCH } from './theme';

export const STARTERS = [
  'How am I recovering from my recent training?',
  'What should I focus on today?',
  'Show me my recent progression.',
  'How has my training load changed this week?',
  'What did I do in my last workout?',
];

const MODE_LABEL: Record<Mode, string> = { fast: 'Fast', default: 'Standard', deep: 'Deep' };
const MODE_HINT: Record<Mode, string> = { fast: 'Quick, short answers', default: 'Balanced — recommended', deep: 'Slower, more thorough' };

// ---------- text ----------

/** The model's text as readable blocks: paragraphs and bullets, markdown markers removed. */
export function textBlocks(text: string): { kind: 'p' | 'li'; text: string }[] {
  return text
    .replace(/\*\*|__|`/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const li = /^([-*•]|\d+[.)])\s+(.*)$/.exec(l);
      return li ? { kind: 'li' as const, text: li[2] } : { kind: 'p' as const, text: l.replace(/^#+\s*/, '') };
    });
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
/** "Today · 18:04" — shown at the start and after a 30-minute gap. */
function stamp(at: string, prev: string | undefined, today: ISODate) {
  if (prev && Date.parse(at) - Date.parse(prev) < 30 * 60_000) return undefined;
  const day = toISODate(new Date(at));
  return `${day === today ? 'Today' : dayMonth(day)} · ${time(at)}`;
}

// ---------- actions ----------

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const CHOICE: Record<string, string> = { adapt: 'APEX’s adaptation', alternative: 'Switch session', recovery_day: 'Recovery day' };

/** What the card shows for an action: title, the key values, when, what it means. Never raw arguments. */
export function actionView(a: ProposedAction, today: ISODate) {
  const g = a.arguments;
  const when = (d: unknown) => (typeof d !== 'string' || d === today ? 'Today' : dayMonth(d));
  if (a.type === 'log_basketball') {
    const values = [`${g.duration_min} min`, `RPE ${g.rpe}`, typeof g.session_type === 'string' && cap(g.session_type), typeof g.lower_body_fatigue === 'string' && `${cap(g.lower_body_fatigue)} leg fatigue`];
    return {
      title: 'Log basketball',
      values: values.filter(Boolean).join(' · '),
      when: when(g.date),
      explain: 'This adds a basketball session to your training history. APEX then re-adapts today’s plan from it.',
    };
  }
  if (a.type === 'adapt_today_workout') {
    return {
      title: 'Adapt today’s workout',
      values: CHOICE[String(g.choice)] ?? 'APEX’s options',
      when: `Today · ${g.session === 'plyometrics' ? 'plyometrics' : 'gym'}`,
      explain: `${a.summary} Only today’s session changes — your program and templates stay as they are.`,
    };
  }
  return { title: cap(a.type.replace(/_/g, ' ')), values: '', when: '', explain: a.summary };
}

/** Preview lines from the server, made to read like the rest of the app. */
const previewLine = (line: string, today: ISODate) =>
  line
    .replace(/ on (\d{4}-\d{2}-\d{2})$/, (_, d: string) => (d === today ? ' today' : ` on ${dayMonth(d)}`))
    .replace(/\((low|moderate|high|extreme)\)$/, (_, b: keyof typeof bandLabel) => `(${bandLabel[b].toLowerCase()})`);

function ActionCard({ msgId, action: a, today, assistant }: { msgId: string; action: ProposedAction; today: ISODate; assistant: Assistant }) {
  const v = actionView(a, today);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  // flip to "expired" when its time is up, without the athlete having to tap
  useEffect(() => {
    if (a.state !== 'pending') return;
    const t = setTimeout(() => { assistant.expire(msgId); tick(); }, Math.max(0, Date.parse(a.expiresAt) - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [a.state, a.expiresAt, assistant, msgId]);

  const busy = a.state === 'confirming' || a.state === 'cancelling';
  const open = a.state === 'pending' || busy;
  const tone = a.state === 'executed' ? C.accent : a.state === 'failed' ? C.danger : C.text2;
  return (
    <View style={[styles.card, { borderLeftColor: open ? C.accent : a.state === 'executed' ? C.accent : C.lineStrong }]} accessibilityLabel={`Proposed action: ${v.title}`}>
      <Txt v="overline" color={open ? C.accent : C.text3}>{v.title}</Txt>
      {!!v.values && <Txt v="h3" style={{ marginTop: S.xs }}>{v.values}</Txt>}
      {!!v.when && <Txt v="label" style={{ marginTop: 2 }}>{v.when}</Txt>}
      <Txt v="bodySm" style={{ marginTop: S.sm }}>{v.explain}</Txt>
      {a.preview.length > 0 && (open || a.state === 'executed') && (
        <View style={{ marginTop: S.md, gap: 6 }}>
          <Txt v="overline">{a.state === 'executed' ? 'What changed' : 'What will change'}</Txt>
          {a.preview.map((p) => (
            <View key={p} style={styles.bullet}>
              <View style={styles.dot} />
              <Txt v="bodySm" color={C.text} style={{ flex: 1 }}>{previewLine(p, today)}</Txt>
            </View>
          ))}
        </View>
      )}
      {!!a.note && (
        <View style={[styles.bullet, { marginTop: S.md }]} accessibilityLiveRegion="polite">
          {a.state === 'executed' && <Icon name="check" size={18} color={C.accent} />}
          <Txt v="bodySm" color={tone} style={{ flex: 1, fontFamily: F.medium }}>{a.note}</Txt>
        </View>
      )}
      {open && (
        <View style={styles.actionRow}>
          <Button label={a.state === 'confirming' ? 'Confirming…' : 'Confirm'} icon={a.state === 'confirming' ? undefined : 'check'} size="md" disabled={busy}
            onPress={() => assistant.confirm(msgId)} accessibilityLabel={`Confirm: ${v.title}${v.values ? `, ${v.values}` : ''}`} style={{ flex: 1 }} />
          <Button label={a.state === 'cancelling' ? 'Cancelling…' : 'Cancel'} variant="secondary" size="md" disabled={busy}
            onPress={() => assistant.cancel(msgId)} accessibilityLabel={`Cancel: ${v.title}`} style={{ flex: 1 }} />
        </View>
      )}
    </View>
  );
}

// ---------- messages ----------

function UserBubble({ m, onRetry, canRetry }: { m: UserMessage; onRetry: () => void; canRetry: boolean }) {
  return (
    <View style={{ alignItems: 'flex-end', gap: 6 }}>
      <View style={[styles.bubble, m.status === 'failed' && { borderColor: C.danger }]}>
        <Txt v="body">{m.text}</Txt>
      </View>
      {m.status === 'sending' && <Txt v="bodySm" color={C.text3}>Sending…</Txt>}
      {m.status === 'failed' && (
        <View style={styles.failRow} accessibilityLiveRegion="polite">
          <Txt v="bodySm" color={C.danger} style={{ flexShrink: 1, textAlign: 'right' }}>{m.error ?? 'Not sent.'}</Txt>
          {m.retry && canRetry && (
            <Pressable onPress={() => { tap(); onRetry(); }} accessibilityRole="button" accessibilityLabel="Retry sending this message" hitSlop={6} style={styles.retry}>
              <Txt v="label" color={C.text} style={{ fontFamily: F.semibold, letterSpacing: 0.9 }}>RETRY</Txt>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

function ApexReply({ m, today, assistant }: { m: ApexMessage; today: ISODate; assistant: Assistant }) {
  return (
    <View style={{ gap: S.sm }}>
      <Txt v="overline" color={C.accent}>APEX</Txt>
      {textBlocks(m.text).map((b, k) =>
        b.kind === 'li' ? (
          <View key={k} style={styles.bullet}>
            <View style={[styles.dot, { backgroundColor: C.text2 }]} />
            <Txt v="body" style={{ flex: 1 }}>{b.text}</Txt>
          </View>
        ) : (
          <Txt key={k} v="body">{b.text}</Txt>
        ))}
      {m.checked.length > 0 && <Txt v="bodySm" color={C.text3}>Checked {m.checked.join(' · ')}</Txt>}
      {m.action && <ActionCard msgId={m.id} action={m.action} today={today} assistant={assistant} />}
    </View>
  );
}

function Thinking() {
  return (
    <View style={styles.thinking} accessibilityLiveRegion="polite" accessibilityLabel="APEX is checking your training">
      <ActivityIndicator size="small" color={C.accent} />
      <Txt v="bodySm">Checking your training…</Txt>
    </View>
  );
}

function Starters({ onPick, disabled }: { onPick: (t: string) => void; disabled: boolean }) {
  return (
    <View style={{ gap: S.md }}>
      <Txt v="bodySm">Ask about your training. Answers come from what you’ve logged, your plan and APEX’s engine.</Txt>
      <View style={styles.starters}>
        {STARTERS.map((s, k) => (
          <Pressable key={s} disabled={disabled} onPress={() => { tap(); onPick(s); }} accessibilityRole="button" accessibilityLabel={`Ask: ${s}`}
            style={({ pressed }) => [styles.starter, k > 0 && styles.starterLine, pressed && { backgroundColor: C.pressed }]}>
            <Txt v="body" style={{ flex: 1 }}>{s}</Txt>
            <Icon name="chevron-right" size={16} color={C.text3} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// ---------- connect ----------

/** Development builds without a built-in server: point the app at a local APEX AI server. No credentials. */
function ServerSetup({ assistant }: { assistant: Assistant }) {
  const [url, setUrl] = useState(assistant.defaultUrl);
  const [bad, setBad] = useState(false);
  const submit = async () => setBad(!(await assistant.connect(url)));
  return (
    <ScrollView contentContainerStyle={{ padding: GUTTER, gap: S.md }} keyboardShouldPersistTaps="handled">
      <Txt v="overline">APEX AI server</Txt>
      <Txt v="body" color={C.text2}>Development build: enter the APEX AI server to use. This device signs itself in — there is nothing else to enter.</Txt>
      <TextInput value={url} onChangeText={setUrl} placeholder={__DEV__ ? 'http://localhost:8787' : undefined} placeholderTextColor={C.text3} autoCapitalize="none" autoCorrect={false}
        keyboardType="url" style={styles.field} accessibilityLabel="APEX AI server address" onSubmitEditing={submit} />
      {bad && <Txt v="bodySm" color={C.danger}>Enter the server address, starting with http:// or https://.</Txt>}
      <Button label="Use this server" onPress={submit} disabled={!url.trim()} />
    </ScrollView>
  );
}

function Unavailable() {
  return (
    <View style={{ padding: GUTTER, gap: S.sm }}>
      <Txt v="overline">APEX AI</Txt>
      <Txt v="body" color={C.text2}>APEX AI isn’t available in this version of the app. Your training works as usual.</Txt>
    </View>
  );
}

// ---------- screen ----------

export function ApexAI({ assistant, today, onBack, allowServerEntry = false }: { assistant: Assistant; today: ISODate; onBack: () => void; allowServerEntry?: boolean }) {
  const s = useSyncExternalStore(assistant.subscribe, assistant.getState, assistant.getState);
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [modeOpen, setModeOpen] = useState(false);
  const list = useRef<ScrollView>(null);
  const connected = !!s.connection;
  const canSend = connected && !s.sending && !!text.trim() && text.length <= MAX_MESSAGE;

  const send = async (t = text) => {
    if (!t.trim() || s.sending) return;
    const ok = await assistant.send(t);
    if (ok && t === text) setText(''); // the composer clears only once APEX answered
  };

  return (
    <KeyboardAvoidingView style={[styles.screen, { paddingTop: insets.top }]} behavior="padding">
      <View style={styles.header}>
        <IconButton icon="chevron-left" label="Back" onPress={onBack} size={40} />
        <View style={{ flex: 1 }}>
          <Txt v="h3" accessibilityRole="header" numberOfLines={1}>APEX AI</Txt>
          <Txt v="overline" numberOfLines={1} style={{ fontSize: 10, letterSpacing: 1.2 }}>Train · Adapt · Perform</Txt>
        </View>
        {connected && (
          <Pressable onPress={() => { tap(); setModeOpen(true); }} accessibilityRole="button" accessibilityLabel={`Answer mode: ${MODE_LABEL[s.mode]}`} hitSlop={4} style={styles.modeChip}>
            <Txt v="label" color={C.text} style={{ fontFamily: F.semibold, fontSize: 11, letterSpacing: 0.6 }}>{MODE_LABEL[s.mode].toUpperCase()}</Txt>
          </Pressable>
        )}
        {connected && s.messages.length > 0 && <IconButton icon="edit" label="New conversation" size={40} onPress={() => { setText(''); void assistant.newConversation(); }} />}
      </View>

      {!s.ready ? (
        <View style={{ flex: 1 }} />
      ) : !connected ? (
        allowServerEntry ? <ServerSetup assistant={assistant} /> : <Unavailable />
      ) : (
        <>
          <ScrollView
            ref={list}
            style={{ flex: 1 }}
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
          >
            {s.messages.length === 0 && <Starters onPick={(t) => void send(t)} disabled={s.sending} />}
            {s.messages.map((m, k) => {
              const at = stamp(m.at, s.messages[k - 1]?.at, today);
              return (
                <View key={m.id} style={{ gap: S.sm }}>
                  {at && <Txt v="overline" style={styles.stamp}>{at}</Txt>}
                  {m.role === 'user'
                    ? <UserBubble m={m} canRetry={!s.sending} onRetry={() => void assistant.retry(m.id).then((ok) => ok && m.text === text.trim() && setText(''))} />
                    : <ApexReply m={m} today={today} assistant={assistant} />}
                </View>
              );
            })}
            {s.sending && <Thinking />}
          </ScrollView>

          {s.authFailed ? (
            <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, S.sm), alignItems: 'center' }]} accessibilityLiveRegion="polite">
              <Txt v="bodySm" color={C.text2} style={{ flex: 1 }}>APEX AI couldn’t sign in on this device.</Txt>
              <Button label="Try again" variant="secondary" size="md" onPress={() => assistant.retrySignIn()} />
            </View>
          ) : (
          <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, S.sm) }]}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Ask about your training"
              placeholderTextColor={C.text3}
              multiline
              maxLength={MAX_MESSAGE}
              editable={!s.sending}
              submitBehavior="submit"
              returnKeyType="send"
              onSubmitEditing={() => void send()}
              onKeyPress={(e) => {
                // web: Enter sends, Shift+Enter is a new line
                const k = e.nativeEvent as unknown as { key: string; shiftKey?: boolean; preventDefault?: () => void };
                if (Platform.OS === 'web' && k.key === 'Enter' && !k.shiftKey) {
                  (e as unknown as { preventDefault: () => void }).preventDefault();
                  void send();
                }
              }}
              style={styles.input}
              accessibilityLabel="Message APEX AI"
            />
            <Pressable onPress={() => { tap(); void send(); }} disabled={!canSend} accessibilityRole="button" accessibilityLabel="Send" accessibilityState={{ disabled: !canSend, busy: s.sending }}
              style={({ pressed }) => [styles.send, { backgroundColor: canSend ? C.accent : C.raised }, pressed && { opacity: 0.85 }]}>
              {s.sending ? <ActivityIndicator size="small" color={C.text2} /> : <Icon name="arrow-up" size={22} color={canSend ? C.onAccent : C.text3} strokeWidth={2.2} />}
            </Pressable>
          </View>
          )}
          {text.length > MAX_MESSAGE - 200 && <Txt v="bodySm" color={C.text3} style={styles.count}>{text.length}/{MAX_MESSAGE}</Txt>}
        </>
      )}

      <BottomSheet visible={modeOpen} onClose={() => setModeOpen(false)} title="Answer mode">
        <View style={{ gap: S.sm }} accessibilityRole="radiogroup">
          {(['fast', 'default', 'deep'] as const).map((m) => (
            <Pressable key={m} onPress={() => { tap(); assistant.setMode(m); setModeOpen(false); }} accessibilityRole="radio" accessibilityState={{ selected: s.mode === m }}
              accessibilityLabel={`${MODE_LABEL[m]}: ${MODE_HINT[m]}`} style={[styles.modeRow, s.mode === m && { borderColor: C.text }]}>
              <View style={{ flex: 1 }}>
                <Txt v="title">{MODE_LABEL[m]}</Txt>
                <Txt v="bodySm">{MODE_HINT[m]}</Txt>
              </View>
              {s.mode === m && <Icon name="check" size={20} color={C.text} />}
            </Pressable>
          ))}
          {s.connection?.custom && (
            <Button label="Change server" variant="secondary" size="md" onPress={() => { setModeOpen(false); void assistant.disconnect(); }} style={{ marginTop: S.md }} />
          )}
        </View>
      </BottomSheet>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingHorizontal: S.sm, paddingVertical: S.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  modeChip: { flexDirection: 'row', alignItems: 'center', height: 36, paddingHorizontal: S.sm, borderRadius: R.sm, backgroundColor: C.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line },
  list: { paddingHorizontal: GUTTER, paddingTop: S.lg, paddingBottom: S.xl, gap: S.xl, flexGrow: 1 },
  stamp: { alignSelf: 'center', fontSize: 10 },
  bubble: { maxWidth: '88%', backgroundColor: C.raised, borderRadius: R.md, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line, paddingHorizontal: S.md, paddingVertical: S.sm + 2 },
  failRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm, maxWidth: '100%' },
  retry: { minHeight: 36, paddingHorizontal: S.md, justifyContent: 'center', borderRadius: R.sm, borderWidth: 1, borderColor: C.lineStrong },
  bullet: { flexDirection: 'row', gap: S.sm, alignItems: 'flex-start' },
  dot: { width: 4, height: 4, borderRadius: 1, backgroundColor: C.text3, marginTop: 8 },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  card: { backgroundColor: C.surface, borderRadius: R.md, borderLeftWidth: 2, paddingVertical: S.md, paddingHorizontal: S.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line },
  actionRow: { flexDirection: 'row', gap: S.sm, marginTop: S.lg },
  starters: { borderRadius: R.md, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line, backgroundColor: C.surface, overflow: 'hidden' },
  starter: { flexDirection: 'row', alignItems: 'center', gap: S.sm, minHeight: TOUCH, paddingHorizontal: S.md, paddingVertical: S.sm },
  starterLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: S.sm, paddingHorizontal: S.md, paddingTop: S.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line, backgroundColor: C.bg },
  input: {
    flex: 1, minHeight: 44, maxHeight: 132, borderRadius: R.md, backgroundColor: C.raised, color: C.text, fontFamily: F.regular, fontSize: 15, lineHeight: 20,
    paddingHorizontal: S.md, paddingTop: 12, paddingBottom: 12, textAlignVertical: 'top',
  },
  send: { width: 44, height: 44, borderRadius: R.md, alignItems: 'center', justifyContent: 'center' },
  count: { textAlign: 'right', paddingHorizontal: S.lg, paddingBottom: S.xs },
  field: { height: TOUCH, borderRadius: R.sm, backgroundColor: C.raised, color: C.text, paddingHorizontal: S.md, fontFamily: F.regular, fontSize: 15 },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, borderRadius: R.md, borderWidth: 1, borderColor: C.line, backgroundColor: C.raised },
});
