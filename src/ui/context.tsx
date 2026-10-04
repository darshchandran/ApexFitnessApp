// Contextual questions: one short ask, in place, only when the domain says Apex needs it.
// Every one can be answered, skipped, or put off — and edited later in Profile.
// Inferred suggestions are offered, never applied without a tap.
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  fromUnits, nextQuestion, slotOf, weekdayPlural, type Focus, type Goal, type GymAfterBasketball, type Question, type Situation, type Sport, type TrainingTime,
} from '@/domain/profile';
import { WEEKDAYS } from '@/domain/schedule';
import type { SessionInstance } from '@/domain/types';
import { apex, useApex } from '@/services/useApex';
import { ApexMark } from './Brand';
import { go } from './nav';
import { Button, Chip, Txt, tap } from './primitives';
import { useUnits } from './units';
import { C, F, GUTTER, R, S } from './theme';

export const GOALS: { value: Goal; label: string; sub: string }[] = [
  { value: 'performance', label: 'Perform', sub: 'Jump higher, move faster, last longer on court' },
  { value: 'muscle', label: 'Build', sub: 'Add muscle and strength' },
  { value: 'both', label: 'Both', sub: 'Athletic performance and muscle' },
];
export const SPORTS: { value: Sport; label: string }[] = [
  { value: 'basketball', label: 'Basketball' }, { value: 'other', label: 'Other' }, { value: 'none', label: 'None' },
];
export const FOCUS: { value: Focus; label: string }[] = [
  { value: 'strength', label: 'Strength' }, { value: 'size', label: 'Size' }, { value: 'jump', label: 'Jump' }, { value: 'speed', label: 'Speed' }, { value: 'general', label: 'All-round' },
];
export const SLOTS: { value: TrainingTime; label: string }[] = [
  { value: 'morning', label: 'Morning' }, { value: 'midday', label: 'Midday' }, { value: 'afternoon', label: 'Afternoon' }, { value: 'evening', label: 'Evening' }, { value: 'varies', label: 'It varies' },
];
export const AFTER: { value: GymAfterBasketball; label: string }[] = [
  { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }, { value: 'sometimes', label: 'Sometimes' }, { value: 'unsure', label: 'Not sure' },
];

const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** "Tue–Thu", "Mon, Wed, Fri". */
export function dayList(days: number[]) {
  const d = [...days].sort((a, b) => a - b);
  if (d.length >= 3 && d.every((x, i) => i === 0 || x === d[i - 1] + 1)) return `${DAY[d[0]]}–${DAY[d[d.length - 1]]}`;
  return d.map((x) => DAY[x]).join(', ');
}
/** '19:00' → "7 PM"; a part of the day stays a word. */
export function timeWords(t: string) {
  if (!t.includes(':')) return t;
  const h = Number(t.slice(0, 2));
  return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
}
export const slotLabel = (t: string | undefined) =>
  !t ? 'Not set' : t === 'varies' ? 'It varies' : t.includes(':') ? `Around ${timeWords(t)} · ${slotOf(t)}` : t[0].toUpperCase() + t.slice(1);

// ---------- building blocks ----------

function TextBtn({ label, onPress, color = C.text2 }: { label: string; onPress: () => void; color?: string }) {
  return (
    <Pressable onPress={() => { tap(); onPress(); }} accessibilityRole="button" hitSlop={8} style={styles.textBtn}>
      <Txt v="label" color={color}>{label}</Txt>
    </Pressable>
  );
}

/**
 * Question frame: title, why, the answer controls, then the quiet exits — Not now (ask again
 * later), Skip (don't ask), and a pointer to Profile, where every answer can be changed.
 */
function Shell({ title, why, children, onLater, onSkip, laterLabel = 'Not now', primary, style }: {
  title: string; why?: string; children?: ReactNode; onLater: () => void; onSkip?: () => void; laterLabel?: string; primary?: ReactNode; style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.shell, style]} accessibilityRole="summary">
      <Txt v="overline" color={C.accent}>Quick setup</Txt>
      <Txt v="title" style={{ marginTop: 4 }}>{title}</Txt>
      {why ? <Txt v="bodySm" style={{ marginTop: 2 }}>{why}</Txt> : null}
      {children ? <View style={{ marginTop: S.md, gap: S.sm }}>{children}</View> : null}
      <View style={[styles.row, styles.footer]}>
        <TextBtn label={laterLabel} onPress={onLater} />
        {onSkip && <TextBtn label="Skip" onPress={onSkip} />}
        <View style={{ marginLeft: 'auto', flexDirection: 'row', gap: S.sm, alignItems: 'center' }}>
          {primary ?? <TextBtn label="Edit later in Profile" color={C.text3} onPress={go.settings} />}
        </View>
      </View>
    </View>
  );
}

function Options<T extends string>({ options, onPick, wrap }: { options: { value: T; label: string }[]; onPick: (v: T) => void; wrap?: boolean }) {
  return (
    <View style={[styles.row, wrap && { flexWrap: 'wrap' }]}>
      {options.map((o) => (
        <Chip key={o.value} label={o.label.toUpperCase()} selected={false} onPress={() => onPick(o.value)}
          style={wrap ? { flexBasis: '30%', flexGrow: 1, paddingHorizontal: 6 } : { flexGrow: 1, flexBasis: 0, paddingHorizontal: 6 }} />
      ))}
    </View>
  );
}

function DayChips({ days, onToggle }: { days: number[]; onToggle: (d: number) => void }) {
  return (
    <View style={styles.row}>
      {WEEKDAYS.map((w, i) => (
        <Chip key={w} label={w} selected={days.includes(i)} onPress={() => onToggle(i)} style={{ flexGrow: 1, flexBasis: 0, paddingHorizontal: 0 }} />
      ))}
    </View>
  );
}

// ---------- one question ----------

function QuestionView({ q, onDone }: { q: Question; onDone: () => void }) {
  const u = useUnits();
  const [editing, setEditing] = useState(false);
  const [days, setDays] = useState(q.days ?? []);
  const [bw, setBw] = useState('');
  const answer = (patch: Parameters<typeof apex.answerQuestion>[1]) => { apex.answerQuestion(q.key, patch); onDone(); };
  const later = () => { apex.deferQuestion(q.key); onDone(); };
  const skip = () => { apex.deferQuestion(q.key, true); onDone(); };
  const saveDays = () => { apex.setBasketballDays(days); onDone(); };
  const toggle = (d: number) => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort((a, b) => a - b));
  const exits = { onLater: later, onSkip: skip };

  switch (q.key) {
    case 'goal':
      return <Shell title="What’s the main goal?" why={q.why} {...exits}><Options options={GOALS} onPick={(goal) => answer({ goal })} /></Shell>;
    case 'sport':
      return <Shell title="Your main sport?" why={q.why} {...exits}><Options options={SPORTS} onPick={(sport) => answer({ sport })} /></Shell>;
    case 'units':
      return (
        <Shell title="Weights in kg or lb?" why={q.why} {...exits}>
          <Options options={[{ value: 'kg' as const, label: 'kg' }, { value: 'lb' as const, label: 'lb' }]} onPick={(units) => answer({ units })} />
        </Shell>
      );
    case 'focus':
      return <Shell title="What are you mainly trying to improve right now?" why={q.why} {...exits}><Options wrap options={FOCUS} onPick={(focus) => answer({ focus })} /></Shell>;
    case 'gymTime':
      return <Shell title="When do you usually train?" why={q.why} {...exits}><Options wrap options={SLOTS} onPick={(gymTime) => answer({ gymTime })} /></Shell>;
    case 'basketballDays':
      return (
        <Shell title="Which days do you usually play basketball?" why={q.why} {...exits} laterLabel="Not sure yet"
          primary={<Button label="Save" size="md" onPress={saveDays} style={{ minWidth: 104 }} />}>
          <DayChips days={days} onToggle={toggle} />
        </Shell>
      );
    case 'basketballWeekday':
      return (
        <Shell title={`Do you usually play basketball on ${weekdayPlural(q.day!)}?`} why={q.why} {...exits}
          primary={
            <>
              <Button label="No" variant="secondary" size="md" onPress={() => { apex.answerBasketballWeekday(q.day!, false); onDone(); }} />
              <Button label="Yes" size="md" onPress={() => { apex.answerBasketballWeekday(q.day!, true); onDone(); }} style={{ minWidth: 80 }} />
            </>
          } />
      );
    case 'suggestBasketballDays':
      return editing ? (
        <Shell title="Which days do you usually play basketball?" {...exits} primary={<Button label="Save" size="md" onPress={saveDays} style={{ minWidth: 104 }} />}>
          <DayChips days={days} onToggle={toggle} />
        </Shell>
      ) : (
        <Shell title={`You usually log basketball ${dayList(q.days ?? [])}. Use this as your typical schedule?`} why={q.why} {...exits}
          primary={
            <>
              <Button label="Edit" variant="secondary" size="md" onPress={() => setEditing(true)} />
              <Button label="Use this" size="md" onPress={saveDays} />
            </>
          } />
      );
    case 'suggestGymTime':
      return editing ? (
        <Shell title="When do you usually train?" {...exits}><Options wrap options={SLOTS} onPick={(gymTime) => answer({ gymTime })} /></Shell>
      ) : (
        <Shell title={`You usually train around ${timeWords(q.time!)}. Set this as your preferred gym time?`} why={q.why} {...exits}
          primary={
            <>
              <Button label="Edit" variant="secondary" size="md" onPress={() => setEditing(true)} />
              <Button label="Yes" size="md" onPress={() => answer({ gymTime: q.time })} style={{ minWidth: 80 }} />
            </>
          } />
      );
    case 'useBasketballLoad':
      return (
        <Shell title="Use basketball workload to adjust your gym sessions?" why={`${q.why} Apex does this by default.`} {...exits}
          primary={<Button label="Yes" size="md" onPress={() => answer({ useBasketballLoad: true })} style={{ minWidth: 88 }} />} />
      );
    case 'gymAfterBasketball':
      return <Shell title="Do you usually train in the gym after basketball?" why={q.why} {...exits}><Options options={AFTER} onPick={(gymAfterBasketball) => answer({ gymAfterBasketball })} /></Shell>;
    case 'bodyweight': {
      const v = Number(bw.replace(',', '.'));
      const ok = bw.trim() !== '' && Number.isFinite(v) && v > 20 && v < (u === 'lb' ? 900 : 400);
      return editing ? (
        <Shell title="Your bodyweight" {...exits}
          primary={<Button label="Save" size="md" disabled={!ok} onPress={() => { apex.addBodyMetric('bodyweight', fromUnits(v, u)); onDone(); }} style={{ minWidth: 96 }} />}>
          <TextInput value={bw} onChangeText={(t) => setBw(t.replace(/[^0-9.,]/g, ''))} keyboardType="decimal-pad" placeholder={u} placeholderTextColor={C.text3} autoFocus
            style={styles.input} accessibilityLabel={`Bodyweight in ${u === 'lb' ? 'pounds' : 'kilograms'}`} maxLength={6} returnKeyType="done" />
        </Shell>
      ) : (
        <Shell title="Want to track bodyweight for your progress?" why={q.why} {...exits}
          primary={<Button label="Yes" size="md" onPress={() => setEditing(true)} style={{ minWidth: 80 }} />} />
      );
    }
    case 'basketballToday':
      // about today only: "Didn't play" and "Not now" both just quiet it for today
      return (
        <Shell title="How hard was basketball today?" why={q.why} onLater={later} laterLabel="Didn’t play"
          primary={<Button label="Log practice" size="md" onPress={() => { onDone(); go.practice(); }} />} />
      );
  }
}

/**
 * The single question worth asking in this place right now, or nothing. Once the athlete has
 * answered or put one off here, this spot stays quiet until they come back.
 */
export function ContextPrompt({ situation, instance, style }: { situation: Situation; instance?: SessionInstance; style?: StyleProp<ViewStyle> }) {
  const { data } = useApex();
  const [now] = useState(() => new Date());
  const [done, setDone] = useState(false);
  if (done) return null;
  const q = nextQuestion(data, situation, now, { today: apex.today(), instance });
  if (!q) return null;
  return <View style={style}><QuestionView key={q.key} q={q} onDone={() => setDone(true)} /></View>;
}

/** First launch: one question, then straight into the app. Skippable — Apex asks again later. */
export function FirstLaunch() {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.first, { paddingTop: insets.top + S.huge, paddingBottom: insets.bottom + S.xl }]}>
      <ApexMark size={28} />
      <Txt v="overline" style={{ marginTop: S.xxxl }}>Welcome to Apex</Txt>
      <Txt v="h1" accessibilityRole="header" style={{ marginTop: S.sm }}>What’s the main goal?</Txt>
      <Txt v="bodySm" style={{ marginTop: S.sm }}>Everything else Apex learns as you train. Change it any time.</Txt>
      <View style={{ marginTop: S.xxl, gap: S.sm }}>
        {GOALS.map((g) => (
          <Pressable key={g.value} onPress={() => { tap(); apex.answerQuestion('goal', { goal: g.value }); }} accessibilityRole="button" accessibilityLabel={`${g.label}: ${g.sub}`}
            style={({ pressed }) => [styles.goal, pressed && { backgroundColor: C.pressed }]}>
            <Txt v="h3">{g.label}</Txt>
            <Txt v="bodySm">{g.sub}</Txt>
          </Pressable>
        ))}
      </View>
      <Button label="Skip for now" variant="ghost" onPress={() => apex.deferQuestion('goal')} style={{ marginTop: 'auto' }} />
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { padding: S.lg, borderRadius: R.lg, backgroundColor: C.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: C.lineStrong },
  row: { flexDirection: 'row', gap: 6 },
  footer: { alignItems: 'center', marginTop: S.md, minHeight: 44 },
  textBtn: { minHeight: 40, justifyContent: 'center', paddingRight: S.md },
  input: { height: 48, borderRadius: R.sm, backgroundColor: C.raised, color: C.text, paddingHorizontal: S.md, fontFamily: F.display, fontSize: 22 },
  first: { flex: 1, backgroundColor: C.bg, paddingHorizontal: GUTTER },
  goal: { paddingVertical: S.lg, paddingHorizontal: S.lg, borderRadius: R.md, borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.surface, gap: 2 },
});
