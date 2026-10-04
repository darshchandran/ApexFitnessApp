import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { usePreventRemove, type NavigationAction } from 'expo-router/react-navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Animated, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { gymExercise, plyoExercise } from '@/domain/catalog';
import { previousPlyo } from '@/domain/history';
import { plyoSetsDone } from '@/domain/load';
import { exerciseHistory, supersetLabels } from '@/domain/logbook';
import { incrementKg } from '@/domain/profile';
import { fatigueFor, recommendProgression } from '@/domain/progression';
import { detectPRs, headlinePRs } from '@/domain/records';
import type { PlyoLog, PlyometricInstance, SessionInstance, SetLog, WorkoutInstance } from '@/domain/types';
import { apex, useApex } from '@/services/useApex';
import { BottomSheet } from '@/ui/BottomSheet';
import { ExerciseBests, ExerciseGraph, ExerciseHistoryList, fmtEffort, fmtSet } from '@/ui/exercise';
import { duration, pad2, prescribedVolume, reduction, repRange, restLabel, sessionProgress, shortDate } from '@/ui/format';
import { Icon, type IconName } from '@/ui/Icon';
import { goBack } from '@/ui/nav';
import { Button, Divider, EmptyState, IconButton, ListRow, PRBadge, ProgressBar, Segmented, StatusChip, Stepper, Txt, tap, useOnce } from '@/ui/primitives';
import { RestTimer, clock, restControls, useNow } from '@/ui/RestTimer';
import { localize, useUnits, WeightStepper, wt, wtu } from '@/ui/units';
import { C, F, GUTTER, R, S, TOUCH } from '@/ui/theme';
import {
  AddExerciseSheet, ChangesSheet, EditSetSheet, FinishSheet, NotesSheet, OverviewSheet, PlyoQuickLogSheet, PrescriptionSheet, PreStart, QuickLogSheet, SwapSheet, WorkoutComplete,
  finished, isAdapted, loggedTotal, nextTimeText, resolvedCount, workingOf, type AnyEx, type GymEx,
} from '@/ui/workout';

type PlyoEx = PlyometricInstance['exercises'][number];

// ---------- header ----------

function Elapsed({ since }: { since?: string }) {
  const now = useNow(1000);
  const sec = since ? Math.max(0, (now - Date.parse(since)) / 1000) : 0;
  const h = Math.floor(sec / 3600);
  return <Text style={styles.elapsed} accessibilityLabel={`Elapsed ${duration(sec * 1000)}`}>{h ? `${h}:${pad2(Math.floor((sec % 3600) / 60))}:${pad2(Math.floor(sec % 60))}` : clock(sec)}</Text>;
}

/** Name, time, today's volume and — when Apex changed the plan — how much, one tap from the details. */
function WorkoutHeader({ inst, onClose, onFinish, onList, onChanges }: { inst: SessionInstance; onClose: () => void; onFinish: () => void; onList: () => void; onChanges: () => void }) {
  const p = sessionProgress(inst);
  const v = prescribedVolume(inst);
  const finish = useOnce(onFinish);
  const changed = inst.decision.outcome !== 'normal';
  return (
    <View>
      <View style={styles.header}>
        <IconButton icon="chevron-down" label="Minimise workout — it stays open" onPress={onClose} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Txt v="overline" color={C.text} numberOfLines={1}>{inst.templateName}</Txt>
          <Elapsed since={inst.startedAt} />
        </View>
        <IconButton icon="list" label="All exercises" onPress={onList} />
        <Pressable onPress={() => { tap(); finish(); }} accessibilityRole="button" accessibilityLabel="Finish workout" hitSlop={4} style={styles.finishBtn}>
          <Text style={styles.finishText}>FINISH</Text>
        </Pressable>
      </View>
      <Pressable onPress={changed ? onChanges : undefined} disabled={!changed} accessibilityRole={changed ? 'button' : undefined}
        accessibilityLabel={`Today: ${p.done} of ${v.value} ${v.unit === 'sets' ? 'working sets' : 'contacts'}${isAdapted(inst) ? `, adapted, volume down ${reduction(inst.decision.volumeFactor)} percent. View changes` : inst.plan === 'kept' && changed ? ', plan kept. View changes' : ''}`}
        style={styles.meta}>
        <Txt v="label" numberOfLines={1} style={{ flexShrink: 1 }}>Today · {p.done}/{v.value} {v.unit === 'sets' ? 'sets' : 'contacts'}</Txt>
        {isAdapted(inst) && <Txt v="label" color={C.accent} numberOfLines={1}>Adapted{inst.decision.volumeFactor < 1 ? ` ↓${reduction(inst.decision.volumeFactor)}%` : ''}</Txt>}
        {inst.plan === 'kept' && changed && <Txt v="label" color={C.text}>Plan kept</Txt>}
        {inst.alternativeFor && <Txt v="label" color={C.text} numberOfLines={1} style={{ flexShrink: 1 }}>Instead of {inst.alternativeFor.templateName}</Txt>}
        {changed && <Txt v="label" color={C.text} style={{ marginLeft: 'auto' }}>View changes ›</Txt>}
      </Pressable>
      <ProgressBar value={p.done / Math.max(1, p.total)} height={2} />
    </View>
  );
}

function ExerciseStrip({ exercises, labels, index, onSelect }: { exercises: AnyEx[]; labels: Record<string, string>; index: number; onSelect: (i: number) => void }) {
  const ref = useRef<ScrollView>(null);
  useEffect(() => { ref.current?.scrollTo({ x: Math.max(0, index * 56 - 112), animated: true }); }, [index]);
  return (
    <ScrollView ref={ref} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
      {exercises.map((e, i) => {
        const cur = i === index;
        const done = finished(e);
        const label = labels[e.id];
        // superset partners sit closer together, so the group reads as one unit
        const joinNext = !!label && labels[exercises[i + 1]?.id]?.[0] === label[0];
        return (
          <Pressable key={e.id} onPress={() => onSelect(i)} accessibilityRole="button" accessibilityLabel={`${label ? `${label} ` : ''}${e.name}${done ? (e.status === 'skipped' ? ', skipped' : ', done') : ''}`} accessibilityState={{ selected: cur }}
            style={[styles.pill, cur && styles.pillCur, done && !cur && styles.pillDone, !!label && !cur && { borderColor: C.accent }, joinNext && { marginRight: -S.sm + 2 }]}>
            {done && !cur
              ? <Icon name={e.status === 'skipped' ? 'minus' : 'check'} size={16} color={C.text3} strokeWidth={2.2} />
              : <Text style={[styles.pillText, cur && { color: C.bg }, !!label && !cur && { color: C.accent }]}>{label ?? pad2(i + 1)}</Text>}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ---------- set rows ----------

function LoggedRow({ n, label, prev, today, note, onPress, warm }: { n: string; label?: string; prev: string; today: string; note?: string; onPress?: () => void; warm?: boolean }) {
  const [a] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(a, { toValue: 1, duration: 200, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [a]);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label ?? `Set ${n}`} logged: ${today}.${note ? ` Note: ${note}.` : ''} Previous ${prev || 'none'}. Tap to edit`}>
      <Animated.View style={[styles.setRow, { opacity: a.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }]}>
        <Text style={[styles.setN, warm && { color: C.text3 }]}>{n}</Text>
        <Text style={styles.setPrev} numberOfLines={1}>{prev}</Text>
        <View style={{ flex: 1.3 }}>
          <Text style={[styles.setToday, warm && { color: C.text2, fontSize: 18 }]} numberOfLines={1}>{today}</Text>
          {note ? <Txt v="bodySm" color={C.text3} numberOfLines={1}>{note}</Txt> : null}
        </View>
        <View style={styles.check}><Icon name="check" size={15} color={C.text3} strokeWidth={2.4} /></View>
      </Animated.View>
    </Pressable>
  );
}

/** A planned set the athlete skipped: visible, quiet, never mistaken for a logged one. */
function SkippedRow({ n, prev, onPress }: { n: string; prev: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Set ${n} skipped. Previous ${prev}. Tap to undo`}>
      <View style={styles.setRow}>
        <Text style={[styles.setN, { color: C.text3 }]}>{n}</Text>
        <Text style={styles.setPrev} numberOfLines={1}>{prev}</Text>
        <Text style={[styles.setToday, { flex: 1.3, color: C.text3, fontFamily: F.displayMedium, fontSize: 17 }]} numberOfLines={1}>Skipped</Text>
        <View style={styles.check}><Icon name="minus" size={15} color={C.text3} strokeWidth={2.4} /></View>
      </View>
    </Pressable>
  );
}

function PendingRow({ n, prev, target, current }: { n: string; prev: string; target: string; current: boolean }) {
  return (
    <View style={[styles.setRow, current && styles.setRowCur]} accessible accessibilityLabel={`Set ${n}${current ? ', up next' : ''}. Previous ${prev}. Target ${target}`}>
      <Text style={[styles.setN, current && { color: C.accent }]}>{n}</Text>
      <Text style={styles.setPrev} numberOfLines={1}>{prev}</Text>
      <Text style={[styles.setToday, { flex: 1.3, color: current ? C.text2 : C.text3, fontFamily: F.displayMedium }]} numberOfLines={1}>{target}</Text>
      <View style={[styles.check, { borderWidth: 1.5, borderColor: current ? C.accent : C.line }]} />
    </View>
  );
}

function TableHead({ today = 'Today' }: { today?: string }) {
  return (
    <View style={[styles.setRow, { minHeight: 26 }]}>
      <Txt v="overline" style={{ width: 28 }}>Set</Txt>
      <Txt v="overline" style={{ flex: 1 }}>Previous</Txt>
      <Txt v="overline" style={{ flex: 1.3 }} color={today === 'Today' ? C.text3 : C.accent}>{today}</Txt>
      <View style={{ width: 28 }} />
    </View>
  );
}

function ActionChip({ icon, label, onPress, active }: { icon: IconName; label: string; onPress: () => void; active?: boolean }) {
  const press = useOnce(onPress);
  return (
    <Pressable onPress={() => { tap(); press(); }} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => [styles.action, active && { borderColor: C.accent }, pressed && { backgroundColor: C.pressed }]}>
      <Icon name={icon} size={18} color={active ? C.accent : C.text} />
      <Text style={[styles.actionText, active && { color: C.accent }]} maxFontSizeMultiplier={1.2}>{label.toUpperCase()}</Text>
    </Pressable>
  );
}

function Recommendation({ icon, accent, strong, reason }: { icon: IconName; accent: boolean; strong?: string; reason: string }) {
  return (
    <View style={styles.rec}>
      <Icon name={icon} size={16} color={accent ? C.accent : C.text2} strokeWidth={2.2} />
      <Txt v="bodySm" style={{ flex: 1 }} color={C.text2}>
        {strong && <Text style={{ color: C.text, fontFamily: F.semibold }}>{strong}  </Text>}
        {reason}
      </Txt>
    </View>
  );
}

// ---------- panel layout: detail scrolls, the set editor stays under the thumb ----------

interface Chrome { header: ReactNode; dock: ReactNode; bottomInset: number }

function PanelLayout({ chrome, editor, children, scrollRef }: { chrome: Chrome; editor: ReactNode; children: ReactNode; scrollRef?: RefObject<ScrollView | null> }) {
  // each exercise mounts its own panel: a short fade makes the hand-off obvious without delaying input
  const [a] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(a, { toValue: 1, duration: 180, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [a]);
  return (
    <View style={{ flex: 1 }}>
      <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ padding: GUTTER, paddingTop: S.md, paddingBottom: S.xxl }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {chrome.header}
        <Animated.View style={{ opacity: a.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) }}>{children}</Animated.View>
      </ScrollView>
      {chrome.dock}
      {editor
        ? <View style={[styles.editor, { paddingBottom: chrome.bottomInset + S.md }]}>{editor}</View>
        : <View style={{ height: chrome.bottomInset }} />}
    </View>
  );
}

/** After the last planned set: done, what next time looks like, and the next exercise — one deliberate tap away. */
function DoneCard({ title, next, nextLabel, onNext, onFinish, onExtra, children }: {
  title: string; next?: AnyEx; nextLabel?: string; onNext: () => void; onFinish: () => void; onExtra?: () => void; children?: ReactNode;
}) {
  return (
    <>
      <View style={styles.editorHead}>
        <Txt v="overline" color={C.text}>{title}</Txt>
        {onExtra && (
          <Pressable onPress={onExtra} accessibilityRole="button" hitSlop={6} style={styles.miniBtn}>
            <Txt v="label" color={C.text}>+ Extra set</Txt>
          </Pressable>
        )}
      </View>
      {children}
      {next ? (
        <View style={{ gap: S.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: S.sm }}>
            <Txt v="overline">Next up</Txt>
            {nextLabel && <Txt v="overline" color={C.accent}>{nextLabel}</Txt>}
          </View>
          <Button label={next.name} icon="chevron-right" onPress={onNext} accessibilityLabel={`Next exercise: ${next.name}`} />
        </View>
      ) : (
        <Button label="Finish workout" icon="check" onPress={onFinish} />
      )}
    </>
  );
}

type Tab = 'track' | 'history' | 'graph';
type Sheet =
  | { type: 'editSet'; exId: string; set: SetLog }
  | { type: 'deletePlyo'; exId: string; logId: string; label: string }
  | { type: 'swap'; exId: string }
  | { type: 'skip'; exId: string }
  | { type: 'notes'; exId: string }
  | { type: 'prescription'; exId: string }
  | { type: 'quick'; exId: string }
  | { type: 'workoutNotes' }
  | { type: 'overview' }
  | { type: 'changes' }
  | { type: 'addExercise' }
  | { type: 'finish' };

interface PanelProps {
  /** "03 / 08" */
  position: string;
  label?: string;
  partner?: { label: string; name: string };
  next?: AnyEx;
  nextLabel?: string;
  onNext: () => void;
  onFinish: () => void;
  onSheet: (s: Sheet) => void;
  chrome: Chrome;
}

// ---------- gym panel ----------

function GymPanel({ inst, ex, position, label, partner, next, nextLabel, onNext, onFinish, onSheet, chrome, effortScale, onLogged }: PanelProps & {
  inst: WorkoutInstance; ex: GymEx; effortScale: 'rir' | 'rpe'; onLogged: (kind: SetLog['kind']) => void;
}) {
  const { data } = useApex();
  const u = useUnits();
  const meta = gymExercise(ex.exerciseId);
  const unit = meta.unit;
  const inc = incrementKg(meta.increment, u); // lb lifters progress in whole lb plates
  const history = useMemo(() => exerciseHistory(data.instances, ex.exerciseId, inst.id), [data.instances, ex.exerciseId, inst.id]);
  const prev = history[0];
  // HISTORY and GRAPH include today's sets so far; BEST / LAST stay on completed sessions
  const withToday = ex.sets.some((s) => s.kind === 'working')
    ? [{ instanceId: inst.id, date: inst.date, templateName: `${inst.templateName} · today`, sets: ex.sets, notes: ex.notes }, ...history]
    : history;
  // cheap and pure — the React Compiler memoizes these
  const prevSets = prev?.sets.filter((s) => s.kind === 'working') ?? [];
  const fatigue = fatigueFor(inst.decision, meta);
  const rec = recommendProgression({ repRange: ex.prescribed.repRange, increment: inc, previous: prevSets, fatigue });
  const working = workingOf(ex);
  // the planned slots in order: logged sets and skipped sets — each one its own record
  const entries = ex.sets.filter((s) => s.kind !== 'warmup');
  const skippedSets = entries.length - working.length;
  const warm = ex.sets.filter((s) => s.kind === 'warmup');
  const lastWorking = working[working.length - 1];

  const [tab, setTab] = useState<Tab>('track');
  const [menu, setMenu] = useState(false);
  const [extra, setExtra] = useState(false);
  const [weight, setWeight] = useState(lastWorking?.weight ?? rec.weight ?? prevSets[0]?.weight ?? 0);
  const [reps, setReps] = useState(Math.max(1, lastWorking?.reps ?? rec.reps));
  // effort is optional: off until the athlete asks for it, then kept on for the exercise
  const [effortOn, setEffortOn] = useState(lastWorking ? lastWorking.rir !== undefined : false);
  const [rir, setRir] = useState(lastWorking?.rir ?? ex.prescribed.targetRir);
  const [kind, setKind] = useState<SetLog['kind']>('working');

  // after each logged set, bring the set table (not the header) into view: the next row is what matters
  const scroll = useRef<ScrollView>(null);
  const tableY = useRef(0);
  const logged = useRef(ex.sets.length);
  useEffect(() => {
    if (ex.sets.length > logged.current) scroll.current?.scrollTo({ y: Math.max(0, tableY.current - S.sm), animated: true });
    logged.current = ex.sets.length;
  }, [ex.sets.length]);

  const rows = Math.max(ex.prescribed.sets, entries.length);
  const target = rec.weight !== undefined ? `${wt(rec.weight, u)} × ${rec.reps}${unit === 'sec' ? 's' : ''}` : repRange(ex.prescribed.repRange, unit);
  const adaptedHere = isAdapted(inst) && ex.templateSets > 0 && ex.prescribed.sets < ex.templateSets;
  const editedHere = !adaptedHere && ex.templateSets > 0 && ex.templateSets !== ex.prescribed.sets;
  const skipped = ex.status === 'skipped';
  const allDone = entries.length >= ex.prescribed.sets;
  const pr = working.length ? headlinePRs(detectPRs({ ...inst, exercises: [ex] }, data.instances))[0] : undefined;
  const nextRec = allDone && working.length ? recommendProgression({ repRange: ex.prescribed.repRange, increment: inc, previous: working, fatigue }) : undefined;

  const log = () => {
    Keyboard.dismiss();
    const saved = apex.logSet(inst.id, ex.id, { kind, weight, reps, rir: kind === 'working' && effortOn ? rir : undefined });
    if (!saved) return;
    onLogged(kind);
    if (kind === 'warmup') setKind('working');
    setExtra(false);
  };

  const effortLabel = effortScale === 'rpe' ? 'RPE' : 'RIR';
  const editor = tab !== 'track' || skipped ? null : allDone && !extra ? (
    <DoneCard title={`Done · ${working.length} ${working.length === 1 ? 'set' : 'sets'}${skippedSets ? ` · ${skippedSets} skipped` : ''}${pr ? ' · PR' : ''}`} next={next} nextLabel={nextLabel} onNext={onNext} onFinish={onFinish} onExtra={() => setExtra(true)}>
      {nextRec && (
        <Recommendation icon={nextRec.action === 'increase' ? 'arrow-up' : 'chevron-right'} accent={nextRec.action === 'increase'}
          strong={`Next time ${nextTimeText(nextRec, Math.max(...working.map((s) => s.weight)), u)}`} reason={localize(nextRec.reason, u)} />
      )}
    </DoneCard>
  ) : (
    <>
      <View style={styles.editorHead}>
        <Txt v="overline" color={C.text} style={{ flex: 1 }} numberOfLines={1}>
          {kind === 'warmup' ? 'Warm-up set' : allDone ? `Extra set ${entries.length + 1}` : `Set ${entries.length + 1} of ${ex.prescribed.sets}`}
        </Txt>
        <Pressable onPress={() => setKind(kind === 'warmup' ? 'working' : 'warmup')} accessibilityRole="switch" accessibilityLabel="Warm-up set" accessibilityState={{ checked: kind === 'warmup' }}
          style={[styles.toggle, kind === 'warmup' && styles.toggleOn]}>
          <Txt v="label" color={kind === 'warmup' ? C.accent : C.text2}>Warm-up</Txt>
        </Pressable>
        {kind === 'working' && (
          <Pressable onPress={() => setEffortOn(!effortOn)} accessibilityRole="switch" accessibilityLabel={`Record ${effortLabel}`} accessibilityState={{ checked: effortOn }}
            style={[styles.toggle, effortOn && styles.toggleOn]}>
            <Txt v="label" color={effortOn ? C.accent : C.text2}>{effortLabel}</Txt>
          </Pressable>
        )}
      </View>
      <View style={{ flexDirection: 'row', gap: S.md }}>
        <WeightStepper value={weight} incrementKg={meta.increment} onChange={setWeight} />
        <Stepper label={unit === 'sec' ? 'Time' : 'Reps'} unit={unit === 'sec' ? 's' : undefined} value={reps} step={unit === 'sec' ? 5 : 1} min={1} max={unit === 'sec' ? 600 : 100} integer onChange={setReps} />
      </View>
      {kind === 'working' && effortOn && (
        effortScale === 'rpe'
          ? <Segmented label="RPE" options={[6, 7, 8, 9, 10] as const} value={(10 - rir) as 6} onChange={(v) => setRir(10 - v)} height={42} />
          : <Segmented label="RIR" options={[0, 1, 2, 3, 4] as const} value={Math.min(4, rir) as 0} onChange={setRir} format={(v) => (v === 4 ? '4+' : String(v))} height={42} />
      )}
      <Button label={kind === 'warmup' ? 'Log warm-up' : 'Log set'} icon="check" onPress={log} disabled={reps < 1}
        accessibilityLabel={`Log ${kind === 'warmup' ? 'warm-up' : 'set'}: ${wt(weight, u)} ${u === 'lb' ? 'pounds' : 'kilograms'}, ${reps} ${unit === 'sec' ? 'seconds' : 'reps'}${kind === 'working' && effortOn ? `, ${fmtEffort(rir, effortScale)}` : ''}`} />
    </>
  );

  const menuItems: { title: string; subtitle?: string; icon: IconName; run: () => void }[] = [
    { title: 'Edit prescription', subtitle: 'Sets, reps, effort and rest — this workout only', icon: 'edit', run: () => onSheet({ type: 'prescription', exId: ex.id }) },
    { title: 'Substitute', subtitle: 'Swap for any exercise — this session only', icon: 'swap', run: () => onSheet({ type: 'swap', exId: ex.id }) },
    ...(ex.substitutedFromId ? [{ title: `Back to ${ex.substitutedFrom}`, subtitle: 'The exercise your template planned', icon: 'swap' as IconName, run: () => apex.substituteExercise(inst.id, ex.id, ex.substitutedFromId!) }] : []),
    ...(!skipped && !allDone ? [{ title: `Skip set ${entries.length + 1}`, subtitle: 'Kept in history as skipped — no volume', icon: 'skip' as IconName, run: () => apex.skipSet(inst.id, ex.id) }] : []),
    { title: 'Add set', icon: 'plus', run: () => apex.addPrescribedSet(inst.id, ex.id) },
    ...(ex.prescribed.sets > 1 ? [{ title: 'Remove set', icon: 'minus' as IconName, run: () => apex.removePrescribedSet(inst.id, ex.id) }] : []),
    skipped
      ? { title: 'Unskip', icon: 'skip', run: () => apex.setExerciseSkipped(inst.id, ex.id, false) }
      : { title: 'Skip exercise', icon: 'skip', run: () => onSheet({ type: 'skip', exId: ex.id }) },
    { title: ex.notes ? 'Edit note' : 'Add note', icon: 'note', run: () => onSheet({ type: 'notes', exId: ex.id }) },
    ...(!skipped ? [{
      title: kind === 'warmup' ? 'Next set is a working set' : 'Mark next set as warm-up', subtitle: 'Warm-ups don’t count as working volume', icon: 'timer' as IconName,
      run: () => { setTab('track'); setExtra(true); setKind(kind === 'warmup' ? 'working' : 'warmup'); },
    }] : []),
    { title: ex.supersetGroup ? 'Unlink superset' : 'Superset with next', subtitle: 'This workout only', icon: 'link', run: () => apex.toggleSuperset(inst.id, ex.id) },
    { title: 'Quick log', subtitle: 'Record sets you’ve already done', icon: 'bolt', run: () => onSheet({ type: 'quick', exId: ex.id }) },
  ];

  return (
    <PanelLayout chrome={chrome} editor={editor} scrollRef={scroll}>
      <View style={styles.exHead}>
        <Txt v="overline" style={styles.position}>{position}</Txt>
        {label && <StatusChip label={`Superset ${label[0]} · ${label}`} tone="accent" />}
        {pr && <PRBadge kind={pr.kind} />}
        {adaptedHere && <StatusChip label={`Adapted ${ex.templateSets} → ${ex.prescribed.sets} sets`} tone="accent" />}
        {editedHere && <StatusChip label={`Today ${ex.templateSets} → ${ex.prescribed.sets} sets`} />}
        {ex.templateSets === 0 && !ex.substitutedFrom && <StatusChip label="Added this session" />}
        {ex.substitutedFrom && <StatusChip label="Substituted for this session" />}
        {skipped && <StatusChip label="Skipped" tone="danger" />}
      </View>
      <Txt v="h2" accessibilityRole="header" numberOfLines={2}>{ex.name}</Txt>
      {ex.substitutedFrom && (
        <View style={styles.subRow}>
          <Txt v="bodySm" style={{ flex: 1 }}>Replaces {ex.substitutedFrom}. Your template is unchanged.</Txt>
          {ex.substitutedFromId && (
            <Pressable onPress={() => apex.substituteExercise(inst.id, ex.id, ex.substitutedFromId!)} accessibilityRole="button" accessibilityLabel={`Back to ${ex.substitutedFrom}`} hitSlop={6} style={styles.miniBtn}>
              <Txt v="label" color={C.text}>Back</Txt>
            </Pressable>
          )}
        </View>
      )}
      {partner && <Txt v="bodySm">Alternate with {partner.label} {partner.name}</Txt>}
      <Txt v="label" style={{ marginTop: S.xs }}>
        {ex.prescribed.sets} × {repRange(ex.prescribed.repRange, unit)} · {effortScale === 'rpe' ? `RPE ${10 - ex.prescribed.targetRir}` : `${ex.prescribed.targetRir} RIR`} · Rest {restLabel(ex.prescribed.restSec)}{ex.prescribed.warmupSets ? ` · ${ex.prescribed.warmupSets} warm-up` : ''}
      </Txt>
      {adaptedHere && <Txt v="bodySm" color={C.accent} style={{ marginTop: 2 }} numberOfLines={2}>{inst.decision.headline}.</Txt>}

      <View style={{ marginTop: S.md }}>
        <Segmented label="Exercise view" options={['track', 'history', 'graph'] as const} value={tab} onChange={setTab} format={(t) => t.toUpperCase()} height={36} />
      </View>

      {tab === 'track' ? (
        <>
          <Recommendation icon={rec.action === 'increase' ? 'arrow-up' : rec.action === 'decrease' ? 'arrow-down' : 'chevron-right'} accent={rec.action === 'increase'}
            strong={rec.weight !== undefined ? `${wtu(rec.weight, u)} × ${rec.reps}${unit === 'sec' ? 's' : ''}` : undefined} reason={localize(rec.reason, u)} />
          <View style={{ marginTop: S.md }} onLayout={(e) => { tableY.current = e.nativeEvent.layout.y; }}>
            {warm.length > 0 && (
              <>
                <Txt v="overline" style={styles.tableLabel}>Warm-up</Txt>
                {warm.map((s, i) => (
                  <LoggedRow key={s.id} warm n="W" label={`Warm-up ${i + 1}`} prev="" today={fmtSet(s, unit, u)} note={s.note} onPress={() => onSheet({ type: 'editSet', exId: ex.id, set: s })} />
                ))}
                <Txt v="overline" style={styles.tableLabel}>Working</Txt>
              </>
            )}
            <TableHead today={isAdapted(inst) ? 'Apex today' : 'Today'} />
            {Array.from({ length: rows }, (_, i) => {
              const s = entries[i];
              const p = prevSets[i] ? fmtSet(prevSets[i], unit, u) : '—';
              if (s?.kind === 'skipped') return <SkippedRow key={s.id} n={String(i + 1)} prev={p} onPress={() => onSheet({ type: 'editSet', exId: ex.id, set: s })} />;
              if (s) {
                const effort = s.rir === undefined ? '' : effortScale === 'rpe' ? ` @${10 - s.rir}` : ` · ${s.rir}`;
                return <LoggedRow key={s.id} n={String(i + 1)} prev={p} today={`${fmtSet(s, unit, u)}${effort}`} note={s.note} onPress={() => onSheet({ type: 'editSet', exId: ex.id, set: s })} />;
              }
              return <PendingRow key={i} n={String(i + 1)} prev={p} target={target} current={i === entries.length && !skipped} />;
            })}
            <Txt v="bodySm" style={{ marginTop: 6 }} color={C.text3}>
              {prev ? `Previous · ${shortDate(prev.date)}` : 'No previous session for this exercise'}{working.some((s) => s.rir !== undefined) ? ` · ${effortLabel} after the value` : ''}
            </Txt>
          </View>
          <View style={styles.actions}>
            <ActionChip icon="plus" label="Set" onPress={() => apex.addPrescribedSet(inst.id, ex.id)} />
            <ActionChip icon="swap" label="Swap" onPress={() => onSheet({ type: 'swap', exId: ex.id })} />
            <ActionChip icon="note" label="Note" onPress={() => onSheet({ type: 'notes', exId: ex.id })} active={!!ex.notes} />
            <ActionChip icon="more" label="More" onPress={() => setMenu(true)} />
          </View>
          {ex.notes ? <Txt v="bodySm" style={{ marginTop: S.md }}>“{ex.notes}”</Txt> : null}
        </>
      ) : (
        <View style={{ marginTop: S.md, gap: S.lg }}>
          <ExerciseBests history={history} unit={unit} />
          {tab === 'history'
            ? <ExerciseHistoryList history={withToday} unit={unit} effortScale={effortScale} limit={12} />
            : <ExerciseGraph history={withToday} unit={unit} />}
        </View>
      )}

      <BottomSheet visible={menu} onClose={() => setMenu(false)} title={ex.name}>
        {menuItems.map((m, i) => (
          <View key={m.title}>
            {i > 0 && <Divider />}
            <ListRow title={m.title} subtitle={m.subtitle} left={<Icon name={m.icon} size={20} color={C.text2} />} onPress={() => { setMenu(false); m.run(); }} />
          </View>
        ))}
      </BottomSheet>
    </PanelLayout>
  );
}

// ---------- plyo panel ----------

const METRIC_LABEL = { jumpHeight: 'Jump height', height: 'Box height', distance: 'Distance' } as const;
type Side = 'both' | 'L' | 'R';

function PlyoPanel({ inst, ex, position, next, nextLabel, onNext, onFinish, onSheet, chrome, onLogged }: PanelProps & {
  inst: PlyometricInstance; ex: PlyoEx; onLogged: (sets: number, rest: boolean) => void;
}) {
  const { data } = useApex();
  const meta = plyoExercise(ex.exerciseId);
  const prev = useMemo(() => previousPlyo(data.instances, ex.exerciseId, inst.id), [data.instances, ex.exerciseId, inst.id]);
  const last = ex.logs[ex.logs.length - 1];
  const [reps, setReps] = useState(last?.reps ?? ex.prescribed.reps);
  const [value, setValue] = useState(last?.value ?? prev?.logs.find((l) => l.value)?.value ?? 0);
  const [side, setSide] = useState<Side>('both');
  const [extra, setExtra] = useState(false);
  const p = ex.prescribed;
  const perSide = p.perSide ? '/side' : '';
  const changed = ex.template && (ex.template.sets !== p.sets || ex.template.reps !== p.reps);
  const skipped = ex.status === 'skipped';
  const fmt = (l: Pick<PlyoLog, 'reps' | 'value' | 'side'>) => `${l.reps}${l.side ? ` ${l.side}` : perSide}${l.value ? ` · ${l.value} cm` : ''}`;
  const best = prev?.logs.reduce((m, l) => Math.max(m, l.value ?? 0), 0);
  const done = plyoSetsDone(ex.logs);
  // every log gets a row, then one pending row per set still to do (an L + R pair is one set)
  const rows = ex.logs.length + Math.max(0, Math.ceil(p.sets - done));

  const log = () => {
    Keyboard.dismiss();
    const saved = apex.logPlyo(inst.id, ex.id, { reps, value: value > 0 ? value : undefined, side: side === 'both' ? undefined : side });
    if (!saved) return;
    // a left-side set goes straight to the right side; rest comes after the pair
    onLogged(side === 'both' ? 1 : 0.5, side !== 'L');
    if (side !== 'both') setSide(side === 'L' ? 'R' : 'L');
    setExtra(false);
  };

  const editor = skipped ? null : done >= p.sets && !extra ? (
    <DoneCard title={`Done · ${Math.floor(done)} sets`} next={next} nextLabel={nextLabel} onNext={onNext} onFinish={onFinish} onExtra={() => setExtra(true)} />
  ) : (
    <>
      <View style={styles.editorHead}>
        <Txt v="overline" color={C.text}>{done >= p.sets ? 'Extra set' : `Set ${Math.floor(done) + 1} of ${p.sets}`}</Txt>
      </View>
      {p.perSide && <Segmented label="Side" options={['both', 'L', 'R'] as const} value={side} onChange={setSide} format={(s) => (s === 'both' ? 'BOTH SIDES' : s === 'L' ? 'LEFT' : 'RIGHT')} height={44} />}
      <View style={{ flexDirection: 'row', gap: S.md }}>
        <Stepper label={p.perSide && side === 'both' ? 'Reps / side' : 'Reps'} value={reps} step={1} min={1} max={100} integer onChange={setReps} />
        {meta.metric && <Stepper label={METRIC_LABEL[meta.metric]} unit="cm" value={value} step={1} min={0} max={1000} onChange={setValue} />}
      </View>
      <Button label="Log set" icon="check" onPress={log}
        accessibilityLabel={`Log set: ${reps} ${p.perSide && side === 'both' ? 'reps per side' : 'reps'}${side !== 'both' ? `, ${side === 'L' ? 'left' : 'right'} side` : ''}${meta.metric && value > 0 ? `, ${value} centimetres` : ''}`} />
    </>
  );

  return (
    <PanelLayout chrome={chrome} editor={editor}>
      <View style={styles.exHead}>
        <Txt v="overline" style={styles.position}>{position}</Txt>
        {changed && <StatusChip label={`Adapted ${ex.template!.sets}×${ex.template!.reps} → ${p.sets}×${p.reps}`} tone="accent" />}
        {ex.substitutedFrom && <StatusChip label="Substituted for this session" />}
        {skipped && <StatusChip label="Skipped" tone="danger" />}
      </View>
      <Txt v="h2" accessibilityRole="header" numberOfLines={2}>{ex.name}</Txt>
      {ex.substitutedFrom && <Txt v="bodySm">Replaces {ex.substitutedFrom}. Your template is unchanged.</Txt>}
      <Txt v="label" style={{ marginTop: S.xs }}>
        {p.sets} × {p.reps}{perSide} · {p.sets * p.reps * (p.perSide ? 2 : 1)} contacts · Rest {restLabel(p.restSec)}
      </Txt>
      {meta.metric && best ? <Recommendation icon="chevron-right" accent={false} strong={`${best} cm`} reason="best last session — quality over quantity." /> : null}

      <View style={{ marginTop: S.lg }}>
        <TableHead today={isAdapted(inst) ? 'Apex today' : 'Today'} />
        {Array.from({ length: rows }, (_, i) => {
          const l = ex.logs[i];
          const pv = prev?.logs[i] ? fmt(prev.logs[i]) : '—';
          // set number, not log number: a left + right pair share one
          const setNo = String(Math.floor(l ? plyoSetsDone(ex.logs.slice(0, i)) : done + (i - ex.logs.length)) + 1);
          if (l) return <LoggedRow key={l.id} n={setNo} prev={pv} today={fmt(l)} onPress={() => onSheet({ type: 'deletePlyo', exId: ex.id, logId: l.id, label: fmt(l) })} />;
          return <PendingRow key={i} n={setNo} prev={pv} target={`${p.reps}${perSide}`} current={i === ex.logs.length && !skipped} />;
        })}
      </View>

      <View style={styles.actions}>
        <ActionChip icon="swap" label="Swap" onPress={() => onSheet({ type: 'swap', exId: ex.id })} />
        <ActionChip icon="skip" label={skipped ? 'Unskip' : 'Skip'} onPress={() => (skipped ? apex.setExerciseSkipped(inst.id, ex.id, false) : onSheet({ type: 'skip', exId: ex.id }))} active={skipped} />
        <ActionChip icon="note" label="Note" onPress={() => onSheet({ type: 'notes', exId: ex.id })} active={!!ex.notes} />
      </View>
      {ex.notes ? <Txt v="bodySm" style={{ marginTop: S.md }}>“{ex.notes}”</Txt> : null}
    </PanelLayout>
  );
}

// ---------- screen ----------

export default function Workout() {
  const { id, ex: exParam, quick } = useLocalSearchParams<{ id: string; ex?: string; quick?: string }>();
  const { data } = useApex();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const inst = data.instances.find((i) => i.id === id);
  const [sheet, setSheet] = useState<Sheet | null>(() => {
    // quick log entry: open the first exercise with sets left in the quick-log sheet
    const i = data.instances.find((x) => x.id === id);
    const first = quick && i && i.status !== 'completed' ? i.exercises.find((e) => e.status !== 'removed' && !finished(e)) : undefined;
    return first ? { type: 'quick', exId: first.id } : null;
  });
  const [pendingLeave, setPendingLeave] = useState<NavigationAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const leaving = useRef(false);
  const visible = useMemo(() => (inst ? (inst.exercises as AnyEx[]).filter((e) => e.status !== 'removed') : []), [inst]);
  const labels = useMemo(() => (inst ? supersetLabels(inst.exercises) : {}), [inst]);
  const [index, setIndex] = useState(() => {
    const k = exParam ? visible.findIndex((e) => e.id === exParam) : -1;
    return k >= 0 ? k : Math.max(0, visible.findIndex((e) => !finished(e)));
  });

  // quick log skips the overview: the session starts as soon as it opens
  useEffect(() => {
    if (quick && inst?.status === 'planned') apex.startInstance(inst.id);
  }, [quick, inst?.id, inst?.status]);

  // Android back / swipe: the session is already saved, but confirm before leaving an open workout.
  usePreventRemove(inst?.status === 'active', ({ data: { action } }) => {
    if (leaving.current) navigation.dispatch(action);
    else setPendingLeave(action);
  });
  /** Deliberate exits (minimise, done, discard) skip the confirmation. */
  const leave = () => {
    leaving.current = true;
    goBack();
  };

  if (!inst) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + S.huge, padding: GUTTER }]}>
        <EmptyState title="Session not found" message="It may have been discarded. Your other sessions are safe." action="Back to Home" onAction={leave} />
      </View>
    );
  }
  if (inst.status === 'completed') {
    return <WorkoutComplete inst={inst} onDone={leave} onSummary={() => { leaving.current = true; router.replace({ pathname: '/session/[id]', params: { id: inst.id } }); }} />;
  }

  const cur = Math.min(index, visible.length - 1);
  const ex = visible[cur];
  const select = (i: number) => {
    setNotice(null);
    setIndex(i); // panels are keyed by exercise, so each opens scrolled to the top
  };
  /** The next unfinished exercise after `from` (wrapping), if any. */
  const nextPending = (from: number) => {
    for (let k = 1; k < visible.length; k++) {
      const j = (from + k) % visible.length;
      if (!finished(visible[j])) return j;
    }
    return -1;
  };

  if (inst.status === 'planned' || inst.status === 'skipped') {
    return (
      <PreStart inst={inst} onClose={leave} onStart={() => apex.startInstance(inst.id)}
        onQuick={() => { apex.startInstance(inst.id); if (ex) setSheet({ type: 'quick', exId: ex.id }); }} />
    );
  }

  const rest = restControls(inst.id, inst.rest);
  const nextIdx = ex ? nextPending(cur) : -1;
  const next = nextIdx >= 0 ? visible[nextIdx] : undefined;
  const groupOf = (e: AnyEx) => ('supersetGroup' in e && e.supersetGroup && labels[e.id] ? visible.filter((x) => 'supersetGroup' in x && x.supersetGroup === e.supersetGroup && !!labels[x.id]) : []);

  /** After a set: superset partners alternate without rest; otherwise rest. Moving on is the athlete's tap. */
  const onLogged = (kind: SetLog['kind'], sets = 1, restAfter = true) => {
    if (kind === 'warmup' || !ex) return;
    const doneAfter = resolvedCount(ex) + sets >= ex.prescribed.sets;
    const group = groupOf(ex);
    if (group.length > 1) {
      const partner = group.slice(group.indexOf(ex) + 1).find((e) => !finished(e));
      if (partner) {
        select(visible.indexOf(partner));
        setNotice(`Superset · now ${labels[partner.id]} ${partner.name}`);
        return;
      }
      // end of a round: rest, then back to the first member with sets left
      if (data.settings.autoRest && restAfter) rest.start(ex.prescribed.restSec);
      const first = group.find((e) => (e === ex ? !doneAfter : !finished(e)));
      if (first && first !== ex) {
        select(visible.indexOf(first));
        setNotice(`Superset · next round ${labels[first.id]} ${first.name}`);
      }
      return;
    }
    if (data.settings.autoRest && restAfter) rest.start(ex.prescribed.restSec);
  };

  const partnerOf = (e: AnyEx) => {
    const g = groupOf(e);
    if (g.length < 2) return undefined;
    const other = g[(g.indexOf(e) + 1) % g.length];
    return { label: labels[other.id], name: other.name };
  };

  const chrome: Chrome = {
    bottomInset: insets.bottom,
    header: notice ? (
      <View style={styles.notice} accessibilityLiveRegion="polite">
        <Icon name="link" size={14} color={C.accent} strokeWidth={2.2} />
        <Txt v="label" color={C.text} numberOfLines={1} style={{ flex: 1 }}>{notice}</Txt>
      </View>
    ) : null,
    dock: <RestTimer instanceId={inst.id} rest={inst.rest} />,
  };
  const panel: PanelProps | undefined = ex && {
    position: `${pad2(cur + 1)} / ${pad2(visible.length)}`,
    label: labels[ex.id],
    partner: partnerOf(ex),
    next,
    nextLabel: next && labels[next.id],
    onNext: () => select(nextIdx),
    onFinish: () => setSheet({ type: 'finish' }),
    onSheet: setSheet,
    chrome,
  };

  /** After a quick-log save: straight on to the next exercise with sets left, or finish when there is none. */
  const quickNext = (exId: string) => {
    const k = visible.findIndex((e) => e.id === exId);
    // `visible` predates the save, so the saved exercise still looks unfinished — skip it explicitly
    let n = -1;
    for (let d = 1; d < visible.length; d++) {
      const j = (k + d) % visible.length;
      if (!finished(visible[j])) { n = j; break; }
    }
    if (n >= 0) {
      select(n);
      setSheet({ type: 'quick', exId: visible[n].id });
    } else setSheet({ type: 'finish' });
  };

  const skipEx = sheet?.type === 'skip' ? inst.exercises.find((e) => e.id === sheet.exId) : undefined;
  const notesEx = sheet?.type === 'notes' ? inst.exercises.find((e) => e.id === sheet.exId) : undefined;

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ paddingTop: insets.top }}>
        <WorkoutHeader inst={inst} onClose={leave} onFinish={() => setSheet({ type: 'finish' })} onList={() => setSheet({ type: 'overview' })} onChanges={() => setSheet({ type: 'changes' })} />
        <ExerciseStrip exercises={visible} labels={labels} index={cur} onSelect={select} />
      </View>
      {!ex && (
        <View style={{ padding: GUTTER }}>
          <EmptyState title="No exercises left" message="Everything in this session was removed. Finish to save it, or discard it." action="Finish" onAction={() => setSheet({ type: 'finish' })} />
        </View>
      )}
      {ex && panel && inst.kind === 'gym' && (
        <GymPanel key={`${ex.id}:${ex.exerciseId}`} {...panel} inst={inst} ex={ex as GymEx} effortScale={data.settings.effortScale} onLogged={onLogged} />
      )}
      {ex && panel && inst.kind === 'plyometric' && (
        <PlyoPanel key={`${ex.id}:${ex.exerciseId}`} {...panel} inst={inst} ex={ex as PlyoEx} onLogged={(n, r) => onLogged('working', n, r)} />
      )}

      {sheet?.type === 'finish' && (
        <FinishSheet inst={inst} onClose={() => setSheet(null)} onDone={() => setSheet(null)}
          onDiscard={() => { setSheet(null); apex.discardInstance(inst.id); leave(); }} />
      )}
      {sheet?.type === 'overview' && (
        <OverviewSheet inst={inst} currentId={ex?.id} onClose={() => setSheet(null)} onNote={() => setSheet({ type: 'workoutNotes' })}
          onAdd={inst.kind === 'gym' ? () => setSheet({ type: 'addExercise' }) : undefined}
          onSelect={(exId) => { const k = visible.findIndex((e) => e.id === exId); if (k >= 0) select(k); }} />
      )}
      {sheet?.type === 'changes' && <ChangesSheet inst={inst} onClose={() => setSheet(null)} />}
      {sheet?.type === 'editSet' && inst.kind === 'gym' && <EditSetSheet inst={inst} exId={sheet.exId} set={sheet.set} effortScale={data.settings.effortScale} onClose={() => setSheet(null)} />}
      {notesEx && (
        <NotesSheet title="Exercise note" sub={notesEx.name} initial={notesEx.notes} placeholder="Seat height 4, grip, how it felt…" onSave={(t) => apex.setExerciseNotes(inst.id, notesEx.id, t)} onClose={() => setSheet(null)} />
      )}
      {sheet?.type === 'workoutNotes' && (
        <NotesSheet title="Workout note" initial={inst.notes} placeholder="e.g. gym was crowded" onSave={(t) => apex.setInstanceNotes(inst.id, t)} onClose={() => setSheet(null)} />
      )}
      {sheet?.type === 'swap' && <SwapSheet inst={inst} exId={sheet.exId} onClose={() => setSheet(null)} />}
      {sheet?.type === 'addExercise' && inst.kind === 'gym' && <AddExerciseSheet inst={inst} onClose={() => setSheet(null)} onAdded={() => select(visible.length)} />}
      {sheet?.type === 'prescription' && inst.kind === 'gym' && <PrescriptionSheet inst={inst} exId={sheet.exId} onClose={() => setSheet(null)} />}
      {sheet?.type === 'quick' && inst.kind === 'gym' && <QuickLogSheet key={sheet.exId} inst={inst} exId={sheet.exId} onClose={() => setSheet(null)} onSaved={() => quickNext(sheet.exId)} />}
      {sheet?.type === 'quick' && inst.kind === 'plyometric' && <PlyoQuickLogSheet key={sheet.exId} inst={inst} exId={sheet.exId} onClose={() => setSheet(null)} onSaved={() => quickNext(sheet.exId)} />}
      {skipEx && (
        <BottomSheet visible onClose={() => setSheet(null)} title={`Skip ${skipEx.name}?`}
          footer={
            <View style={{ gap: S.md }}>
              <Button label="Keep exercise" onPress={() => setSheet(null)} />
              <Button label="Skip exercise" variant="secondary" icon="skip" onPress={() => { apex.setExerciseSkipped(inst.id, skipEx.id, true); setSheet(null); }} />
            </View>
          }>
          <Txt v="body" color={C.text2}>It stays in the session marked as skipped. You can unskip it any time before finishing.</Txt>
        </BottomSheet>
      )}
      {sheet?.type === 'deletePlyo' && (
        <BottomSheet visible onClose={() => setSheet(null)} title="Logged set"
          footer={<Button label="Delete set" variant="danger" icon="trash" onPress={() => { apex.deletePlyoLog(inst.id, sheet.exId, sheet.logId); setSheet(null); }} />}>
          <Txt v="body">{sheet.label}</Txt>
        </BottomSheet>
      )}
      {pendingLeave && (
        <BottomSheet visible onClose={() => setPendingLeave(null)} title="Leave workout?"
          footer={
            <View style={{ gap: S.md }}>
              <Button label="Continue workout" onPress={() => setPendingLeave(null)} />
              <Button label="Leave workout" variant="secondary" onPress={() => { leaving.current = true; const a = pendingLeave; setPendingLeave(null); navigation.dispatch(a); }} />
            </View>
          }>
          <Txt v="body" color={C.text2}>
            {loggedTotal(inst) ? `${loggedTotal(inst)} logged ${loggedTotal(inst) === 1 ? 'set is' : 'sets are'} saved on this device.` : 'Nothing is lost.'} The session stays open — resume it from Home.
          </Txt>
        </BottomSheet>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: S.sm, gap: S.xs },
  meta: { flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingHorizontal: GUTTER, paddingBottom: 6, minHeight: 28 },
  elapsed: { fontFamily: F.display, fontSize: 22, lineHeight: 24, color: C.text, fontVariant: ['tabular-nums'] },
  finishBtn: { height: TOUCH - 4, paddingHorizontal: S.lg, borderRadius: R.sm, backgroundColor: C.text, alignItems: 'center', justifyContent: 'center', marginRight: S.sm },
  finishText: { fontFamily: F.semibold, fontSize: 13, letterSpacing: 1.2, color: C.bg },
  strip: { paddingHorizontal: GUTTER, paddingVertical: 6, gap: S.sm },
  pill: { width: 48, height: 38, borderRadius: R.sm, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
  pillCur: { backgroundColor: C.text, borderColor: C.text },
  pillDone: { backgroundColor: C.surface, borderColor: C.surface },
  pillText: { fontFamily: F.display, fontSize: 17, color: C.text2, fontVariant: ['tabular-nums'] },
  notice: { flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingVertical: 6, paddingHorizontal: S.md, marginBottom: S.sm, borderRadius: R.sm, backgroundColor: C.accentSoft, alignSelf: 'flex-start', maxWidth: '100%' },
  exHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: S.sm, marginBottom: S.sm },
  position: { color: C.text2, marginRight: 2 },
  rec: { flexDirection: 'row', gap: S.sm, marginTop: S.md, padding: S.md, borderRadius: R.md, backgroundColor: C.surface, alignItems: 'flex-start' },
  tableLabel: { marginTop: S.sm, marginBottom: 2 },
  setRow: { flexDirection: 'row', alignItems: 'center', minHeight: 46, gap: S.sm, paddingHorizontal: S.xs, borderRadius: R.sm, borderLeftWidth: 2, borderLeftColor: 'transparent' },
  setRowCur: { backgroundColor: C.surface, borderLeftColor: C.accent },
  setN: { width: 28, fontFamily: F.display, fontSize: 18, color: C.text2, fontVariant: ['tabular-nums'] },
  setPrev: { flex: 1, fontFamily: F.displayMedium, fontSize: 18, color: C.text3, fontVariant: ['tabular-nums'] },
  setToday: { fontFamily: F.display, fontSize: 21, color: C.text, fontVariant: ['tabular-nums'] },
  check: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  editorHead: { flexDirection: 'row', alignItems: 'center', gap: S.sm, minHeight: 36 },
  toggle: { minHeight: 36, paddingHorizontal: S.md, borderRadius: R.sm, borderWidth: 1, borderColor: C.line, justifyContent: 'center' },
  toggleOn: { borderColor: C.accent, backgroundColor: C.accentSoft },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  miniBtn: { minHeight: 36, paddingHorizontal: S.md, borderRadius: R.sm, borderWidth: 1, borderColor: C.line, justifyContent: 'center', marginLeft: 'auto' },
  editor: { gap: 10, paddingHorizontal: GUTTER, paddingTop: S.md, backgroundColor: C.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.lineStrong },
  actions: { flexDirection: 'row', gap: S.sm, marginTop: S.lg },
  action: { flex: 1, height: 56, borderRadius: R.md, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center', gap: 3 },
  actionText: { fontFamily: F.semibold, fontSize: 10, letterSpacing: 1, color: C.text },
});
