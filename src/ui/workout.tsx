// Sheets and full-screen states of the live workout: pre-start, exercise list, what changed,
// set / prescription / note editing, quick log, finish and completion.
import { useEffect, useMemo, useState } from 'react';
import { Animated, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GYM_EXERCISES, gymExercise, MUSCLE_LABEL, PLYO_EXERCISES, plyoExercise, plyoSubstitutesFor, substitutesFor } from '@/domain/catalog';
import { previousPerformance, previousPlyo } from '@/domain/history';
import { plyoSetsDone } from '@/domain/load';
import { planVsActual, supersetLabels, workoutSummary } from '@/domain/logbook';
import type { Recommendation } from '@/domain/progression';
import type { Units } from '@/domain/profile';
import type { PersonalRecord, PlyometricInstance, SessionInstance, SetLog, WorkoutInstance } from '@/domain/types';
import { apex, useApex } from '@/services/useApex';
import { BottomSheet } from './BottomSheet';
import { ApexMark } from './Brand';
import { ContextPrompt } from './context';
import { compactSets } from './exercise';
import { localize, useUnits, WeightStepper, wtu } from './units';
import { duration, estimatedMinutes, pad2, prescribedVolume, reduction, repRange, restLabel, sessionProgress, statusOf } from './format';
import { Icon } from './Icon';
import { ApexCard, Button, Chip, Divider, IconButton, ListRow, PRBadge, Segmented, StatusChip, Stepper, Txt, useOnce } from './primitives';
import { AdaptationNote } from './training';
import { bandLabel, C, F, GUTTER, R, S } from './theme';

export type GymEx = WorkoutInstance['exercises'][number];
export type AnyEx = SessionInstance['exercises'][number];

export const workingOf = (e: GymEx) => e.sets.filter((s) => s.kind === 'working');
export const loggedCount = (e: AnyEx) => ('sets' in e ? workingOf(e as GymEx).length : plyoSetsDone(e.logs));
/** Planned set slots dealt with: logged or deliberately skipped (warm-ups don't fill a slot). */
export const resolvedCount = (e: AnyEx) => ('sets' in e ? (e as GymEx).sets.filter((s) => s.kind !== 'warmup').length : plyoSetsDone(e.logs));
export const finished = (e: AnyEx) => e.status === 'skipped' || e.status === 'removed' || resolvedCount(e) >= e.prescribed.sets;
export const loggedTotal = (i: SessionInstance) => i.exercises.reduce((n, e) => n + ('sets' in e ? e.sets.length : e.logs.length), 0);
export const isAdapted = (i: SessionInstance) => i.plan !== 'kept' && i.decision.outcome !== 'normal';

const rxOf = (i: SessionInstance, e: AnyEx) =>
  i.kind === 'gym'
    ? `${e.prescribed.sets} × ${repRange((e as GymEx).prescribed.repRange, gymExercise(e.exerciseId).unit)}`
    : `${e.prescribed.sets} × ${'reps' in e.prescribed ? e.prescribed.reps : ''}${'perSide' in e.prescribed && e.prescribed.perSide ? '/side' : ''}`;
const programmedOf = (e: AnyEx) => ('templateSets' in e ? e.templateSets : e.template?.sets ?? e.prescribed.sets);

/** What the existing progression engine recommends, in a few words: "+2 kg → 14.5 kg", "Maintain 80 kg". */
export function nextTimeText(rec: Recommendation, top: number, u: Units) {
  if (rec.weight === undefined) return 'Establish a working weight';
  if (rec.action === 'increase') return `+${wtu(rec.weight - top, u)} → ${wtu(rec.weight, u)}`;
  if (rec.action === 'add_reps') return `${wtu(rec.weight, u)} × ${rec.reps}`;
  if (rec.action === 'decrease') return wtu(rec.weight, u);
  return `Maintain ${wtu(rec.weight, u)}`;
}

// ---------- exercise list (pre-start + overview sheet) ----------

function Glyph({ e, current }: { e: AnyEx; current: boolean }) {
  if (current) return <View style={[styles.glyph, { backgroundColor: C.accent, borderColor: C.accent }]} />;
  if (e.status === 'skipped') return <Icon name="minus" size={14} color={C.text3} strokeWidth={2.2} />;
  if (finished(e)) return <Icon name="check" size={14} color={C.text2} strokeWidth={2.4} />;
  return <View style={styles.glyph} />;
}

/** Every exercise in order: superset groups labelled A1/A2, Apex's changes and last performance visible. */
export function WorkoutList({ inst, currentId, onSelect, live }: { inst: SessionInstance; currentId?: string; onSelect?: (exId: string) => void; live?: boolean }) {
  const { data } = useApex();
  const w = useUnits();
  const labels = useMemo(() => supersetLabels(inst.exercises), [inst.exercises]);
  const shown = inst.exercises.filter((e) => e.status !== 'removed');
  const removed = inst.exercises.filter((e) => e.status === 'removed');
  const prev = useMemo(() => {
    const m = new Map<string, SetLog[]>();
    if (inst.kind === 'gym') for (const e of inst.exercises) m.set(e.exerciseId, previousPerformance(data.instances, e.exerciseId, inst.id)?.sets ?? []);
    return m;
  }, [data.instances, inst.exercises, inst.id, inst.kind]);

  return (
    <View>
      {shown.map((e, k) => {
        const label = labels[e.id];
        const groupStart = label?.endsWith('1');
        const programmed = programmedOf(e);
        const changed = programmed > 0 && programmed !== e.prescribed.sets;
        const p = prev.get(e.exerciseId) ?? [];
        const unit = inst.kind === 'gym' ? gymExercise(e.exerciseId).unit : undefined;
        const n = loggedCount(e);
        return (
          <View key={e.id}>
            {k > 0 && !(label && !groupStart) && <Divider />}
            {groupStart && <Txt v="overline" color={C.accent} style={styles.ssHead}>Superset {label![0]}</Txt>}
            <Pressable onPress={onSelect ? () => onSelect(e.id) : undefined} disabled={!onSelect} accessibilityRole={onSelect ? 'button' : undefined}
              accessibilityState={{ selected: e.id === currentId }}
              accessibilityLabel={`${label ?? k + 1}. ${e.name}: ${rxOf(inst, e)}${changed ? `, changed from ${programmed} sets` : ''}${live ? `, ${n} logged` : ''}${e.status === 'skipped' ? ', skipped' : ''}`}
              style={({ pressed }) => [styles.listRow, label && styles.ssRow, pressed && { backgroundColor: C.pressed }]}>
              {live && <View style={styles.glyphWrap}><Glyph e={e} current={e.id === currentId} /></View>}
              <Text style={[styles.listIdx, label && { color: C.accent }]}>{label ?? pad2(k + 1)}</Text>
              <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
                <Txt v="body" numberOfLines={2} color={live && finished(e) && e.id !== currentId ? C.text2 : C.text} style={e.id === currentId && { fontFamily: F.semibold }}>{e.name}</Txt>
                {p.length > 0 && <Txt v="bodySm" color={C.text3} numberOfLines={1}>Last · {compactSets(p, unit, w)}</Txt>}
                {changed && <Txt v="bodySm" color={e.prescribed.sets < programmed && isAdapted(inst) ? C.accent : C.text2}>{programmed} → {e.prescribed.sets} {e.prescribed.sets === 1 ? 'set' : 'sets'}{e.prescribed.sets < programmed && isAdapted(inst) ? ' · Apex' : ' · today'}</Txt>}
                {e.substitutedFrom && <Txt v="bodySm">Replaces {e.substitutedFrom}</Txt>}
              </View>
              <Txt v="label" color={live && n ? C.text : C.text2}>{live ? `${Math.min(n, e.prescribed.sets)}/${e.prescribed.sets}` : rxOf(inst, e)}</Txt>
            </Pressable>
          </View>
        );
      })}
      {removed.length > 0 && (
        <View style={{ marginTop: S.md }}>
          <Txt v="overline" style={{ marginBottom: 4 }}>Removed by Apex today</Txt>
          {removed.map((e) => (
            <View key={e.id} style={styles.removedRow}>
              <Txt v="body" color={C.text3} style={{ flex: 1, textDecorationLine: 'line-through' }} numberOfLines={1}>{e.name}</Txt>
              {inst.kind === 'gym' && inst.status !== 'completed' && (
                <Pressable onPress={() => apex.editPrescription(inst.id, e.id, { sets: Math.max(1, programmedOf(e)) })} accessibilityRole="button" accessibilityLabel={`Add ${e.name} back`} hitSlop={8} style={styles.textBtn}>
                  <Txt v="label" color={C.text}>Add back</Txt>
                </Pressable>
              )}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export function OverviewSheet({ inst, currentId, onSelect, onNote, onAdd, onClose }: {
  inst: SessionInstance; currentId?: string; onSelect: (exId: string) => void; onNote: () => void; onAdd?: () => void; onClose: () => void;
}) {
  const p = sessionProgress(inst);
  return (
    <BottomSheet visible onClose={onClose} title={inst.templateName}
      footer={
        <View style={{ flexDirection: 'row', gap: S.md }}>
          {onAdd && <Button label="Add exercise" variant="secondary" size="md" icon="plus" onPress={onAdd} style={{ flex: 1 }} />}
          <Button label={inst.notes ? 'Workout note' : 'Add note'} variant="secondary" size="md" icon="note" onPress={onNote} style={{ flex: 1 }} />
        </View>
      }>
      <Txt v="bodySm" style={{ marginBottom: S.sm }}>{p.done} of {p.total} working sets logged. Tap an exercise to jump to it.</Txt>
      <WorkoutList inst={inst} currentId={currentId} live onSelect={(id) => { onSelect(id); onClose(); }} />
    </BottomSheet>
  );
}

/** Search the exercise library. Picking adds or swaps for this session only. */
function ExerciseSearch({ kind, exclude, onPick }: { kind: SessionInstance['kind']; exclude: string[]; onPick: (id: string) => void }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const all = kind === 'gym'
      ? GYM_EXERCISES.map((e) => ({ id: e.id, name: e.name, sub: MUSCLE_LABEL[e.primary] }))
      : PLYO_EXERCISES.map((e) => ({ id: e.id, name: e.name, sub: e.categories.join(' · ') }));
    return all.filter((e) => !exclude.includes(e.id) && (!s || e.name.toLowerCase().includes(s) || e.sub.toLowerCase().includes(s)));
  }, [q, kind, exclude]);
  return (
    <View>
      <View style={styles.search}>
        <Icon name="search" size={18} color={C.text3} />
        <TextInput value={q} onChangeText={setQ} placeholder="Search exercise or muscle" placeholderTextColor={C.text3} style={styles.searchInput} accessibilityLabel="Search exercises" />
      </View>
      {list.map((e, i) => (
        <View key={e.id}>
          {i > 0 && <Divider />}
          <ListRow title={e.name} subtitle={e.sub} onPress={() => onPick(e.id)} />
        </View>
      ))}
      {!list.length && <Txt v="bodySm" style={{ paddingVertical: S.lg }}>Nothing matches “{q}”.</Txt>}
    </View>
  );
}

export function AddExerciseSheet({ inst, onAdded, onClose }: { inst: WorkoutInstance; onAdded: (exId: string) => void; onClose: () => void }) {
  return (
    <BottomSheet visible onClose={onClose} title="Add exercise">
      <Txt v="bodySm" style={{ marginBottom: S.sm }}>Today’s workout only — {inst.templateName} stays as written. Starts at 3 sets; edit it from the exercise menu.</Txt>
      <ExerciseSearch kind="gym" exclude={[]} onPick={(id) => { const added = apex.addExerciseToInstance(inst.id, id); if (added) onAdded(added); onClose(); }} />
    </BottomSheet>
  );
}

// ---------- adaptation ----------

/** Exactly what differs from the template today, and why. */
export function ChangesSheet({ inst, onClose }: { inst: SessionInstance; onClose: () => void }) {
  const v = planVsActual(inst);
  const kept = inst.plan === 'kept';
  const diffs = inst.exercises.filter((e) => e.status === 'removed' || programmedOf(e) !== e.prescribed.sets || e.substitutedFrom || e.status === 'skipped');
  return (
    <BottomSheet visible onClose={onClose} title="What changed today">
      <AdaptationNote decision={inst.decision} plan={inst.plan} />
      <View style={styles.pva}>
        {([['Planned', v.planned], [kept ? 'Kept plan' : 'Apex', v.prescribed], ['Done', v.done]] as const).map(([l, n]) => (
          <View key={l} style={{ flex: 1 }}>
            <Txt v="overline">{l}</Txt>
            <Txt v="num" color={l === 'Apex' && v.prescribed !== v.planned ? C.accent : C.text}>{n}</Txt>
          </View>
        ))}
        <Txt v="overline" style={{ alignSelf: 'flex-end', marginBottom: 4 }}>{v.unit}</Txt>
      </View>
      {diffs.length ? diffs.map((e, k) => (
        <View key={e.id}>
          {k > 0 && <Divider />}
          <View style={styles.diffRow}>
            <Txt v="body" style={{ flex: 1 }} numberOfLines={2}>{e.name}</Txt>
            <Txt v="label" color={e.status === 'removed' || e.prescribed.sets < programmedOf(e) ? C.accent : C.text2}>
              {e.status === 'removed' ? 'Removed' : e.status === 'skipped' ? 'Skipped' : programmedOf(e) !== e.prescribed.sets ? `${programmedOf(e)} → ${e.prescribed.sets} ${e.prescribed.sets === 1 ? 'set' : 'sets'}` : 'Substituted'}
            </Txt>
          </View>
        </View>
      )) : <Txt v="bodySm">Every exercise is as programmed.</Txt>}
      {inst.status === 'active' && <Txt v="bodySm" color={C.text3} style={{ marginTop: S.md }}>The session has started, so Apex won’t change it again. Edit any exercise from its menu — your template stays as written.</Txt>}
    </BottomSheet>
  );
}

// ---------- pre-start ----------

/** Today's prescription before the first set: what Apex changed, every exercise, one tap to start. */
export function PreStart({ inst, onStart, onQuick, onClose }: { inst: SessionInstance; onStart: () => void; onQuick: () => void; onClose: () => void }) {
  const { data } = useApex();
  const insets = useSafeAreaInsets();
  const altId = inst.decision.alternativeTemplateId;
  const altName = altId ? [...data.templates, ...data.plyoTemplates].find((t) => t.id === altId)?.name : undefined;
  const v = prescribedVolume(inst);
  const changed = inst.decision.outcome !== 'normal';
  const skipped = inst.status === 'skipped';
  const status = statusOf(inst);
  const start = useOnce(onStart);
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.preHeader}>
        <IconButton icon="chevron-down" label="Close" onPress={onClose} />
        <Txt v="overline">Today’s workout</Txt>
        <View style={{ width: 48 }} />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: S.xxl }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
          <StatusChip label={status.label} tone={status.tone} />
          {isAdapted(inst) && inst.decision.volumeFactor < 1 && <Txt v="label" color={C.accent}>Volume ↓ {reduction(inst.decision.volumeFactor)}%</Txt>}
        </View>
        <Txt v="h1" accessibilityRole="header" style={{ marginTop: S.sm }}>{inst.templateName}</Txt>
        <Txt v="label" style={{ marginTop: 4 }}>{inst.exercises.filter((e) => e.status !== 'removed').length} exercises · {v.value} {v.unit === 'sets' ? 'working sets' : 'contacts'} · ~{estimatedMinutes(inst)} min</Txt>
        {inst.alternativeFor && !skipped && (
          <View style={styles.altRow}>
            <Txt v="bodySm" style={{ flex: 1 }}>Instead of {inst.alternativeFor.templateName}, as Apex suggested.</Txt>
            <Button label={`Back to ${inst.alternativeFor.templateName}`} variant="secondary" size="md" onPress={() => apex.undoAlternative(inst.id)} />
          </View>
        )}
        {skipped ? (
          <Txt v="bodySm" style={{ marginTop: S.lg }}>Set aside as a recovery day. Bring it back to train it today.</Txt>
        ) : changed ? (
          <View style={{ marginTop: S.xl }}>
            <AdaptationNote decision={inst.decision} plan={inst.plan} controls onPlanMode={(m) => apex.setPlanMode(inst.id, m)}
              alternativeName={altName} onAlternative={altName ? () => apex.useAlternative(inst.id) : undefined} onRecovery={() => apex.takeRecoveryDay(inst.id)} />
          </View>
        ) : null}
        {!skipped && <ContextPrompt situation="session" instance={inst} style={{ marginTop: S.xl }} />}
        <ApexCard padded={false} style={{ marginTop: S.xl, paddingHorizontal: S.lg }}>
          <WorkoutList inst={inst} />
        </ApexCard>
      </ScrollView>
      <View style={[styles.preFooter, { paddingBottom: insets.bottom + S.md }]}>
        {skipped ? (
          <Button label="Bring it back" onPress={() => apex.undoRecoveryDay(inst.id)} />
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: S.md }}>
              <Button label="Quick log" variant="secondary" onPress={onQuick} style={{ flex: 1 }} accessibilityLabel="Quick log sets you have already done" />
              <Button label="Log all" icon="play" onPress={start} style={{ flex: 2 }} accessibilityLabel="Log all: start the workout with every exercise ready to log" />
            </View>
            <Txt v="bodySm" color={C.text3} style={{ textAlign: 'center', marginTop: 6 }}>Every exercise ready to log. Nothing is marked done.</Txt>
          </>
        )}
      </View>
    </View>
  );
}

// ---------- set / exercise / workout editing ----------

export function EditSetSheet({ inst, exId, set, effortScale, onClose }: { inst: WorkoutInstance; exId: string; set: SetLog; effortScale: 'rir' | 'rpe'; onClose: () => void }) {
  const ex = inst.exercises.find((e) => e.id === exId);
  const meta = gymExercise(ex?.exerciseId ?? '');
  const [w, setW] = useState(set.weight);
  const [r, setR] = useState(set.reps);
  const [kind, setKind] = useState(set.kind);
  const [rir, setRir] = useState<number | undefined>(set.rir);
  const [note, setNote] = useState(set.note ?? '');
  if (!ex) return null;
  if (set.kind === 'skipped') {
    return (
      <BottomSheet visible onClose={onClose} title="Skipped set"
        footer={<Button label="Undo skip" variant="secondary" onPress={() => { apex.deleteSet(inst.id, ex.id, set.id); onClose(); }} />}>
        <Txt v="body" color={C.text2}>Kept in this workout’s history as skipped — it doesn’t count as volume or toward records. Undo it to log the set instead.</Txt>
      </BottomSheet>
    );
  }
  const effortOptions = effortScale === 'rpe' ? ([-1, 6, 7, 8, 9, 10] as const) : ([-1, 0, 1, 2, 3, 4] as const);
  const effortValue = rir === undefined ? -1 : effortScale === 'rpe' ? 10 - rir : Math.min(4, rir);
  return (
    <BottomSheet visible onClose={onClose} title={kind === 'warmup' ? 'Edit warm-up' : 'Edit set'}
      footer={
        <View style={{ flexDirection: 'row', gap: S.md }}>
          <Button label="Delete" variant="danger" icon="trash" onPress={() => { apex.deleteSet(inst.id, ex.id, set.id); onClose(); }} style={{ flex: 1 }} />
          <Button label="Save" onPress={() => { apex.updateSet(inst.id, ex.id, set.id, { weight: w, reps: r, kind, rir: kind === 'working' ? rir : undefined, note }); onClose(); }} style={{ flex: 1 }} />
        </View>
      }>
      <Segmented label="Set type" options={['working', 'warmup'] as const} value={kind} onChange={setKind} format={(k) => (k === 'warmup' ? 'WARM-UP' : 'WORKING')} height={44} />
      <View style={{ flexDirection: 'row', gap: S.md, marginTop: S.lg }}>
        <WeightStepper value={w} incrementKg={meta.increment} onChange={setW} />
        <Stepper label={meta.unit === 'sec' ? 'Time' : 'Reps'} value={r} step={1} min={1} max={meta.unit === 'sec' ? 600 : 100} integer onChange={setR} />
      </View>
      {kind === 'working' && (
        <View style={{ marginTop: S.lg }}>
          <Txt v="overline" style={{ marginBottom: S.sm }}>{effortScale === 'rpe' ? 'RPE' : 'Reps in reserve'} · optional</Txt>
          <Segmented label="Effort" options={effortOptions} value={effortValue as -1} height={48}
            onChange={(v) => setRir(v === -1 ? undefined : effortScale === 'rpe' ? 10 - v : v)} format={(v) => (v === -1 ? '—' : v === 4 && effortScale === 'rir' ? '4+' : String(v))} />
        </View>
      )}
      <TextInput value={note} onChangeText={setNote} maxLength={300} placeholder="Set note — e.g. felt strong" placeholderTextColor={C.text3}
        style={[styles.input, { marginTop: S.lg }]} accessibilityLabel="Set note" returnKeyType="done" />
    </BottomSheet>
  );
}

export function NotesSheet({ title, sub, initial, placeholder, onSave, onClose }: { title: string; sub?: string; initial?: string; placeholder: string; onSave: (t: string) => void; onClose: () => void }) {
  const [text, setText] = useState(initial ?? '');
  return (
    <BottomSheet visible onClose={onClose} title={title} footer={<Button label="Save note" onPress={() => { onSave(text.trim()); onClose(); }} />}>
      {sub && <Txt v="bodySm" style={{ marginBottom: S.sm }}>{sub}</Txt>}
      <TextInput value={text} onChangeText={setText} multiline autoFocus maxLength={300} placeholder={placeholder} placeholderTextColor={C.text3}
        style={[styles.input, { minHeight: 120, textAlignVertical: 'top' }]} accessibilityLabel={title} />
    </BottomSheet>
  );
}

const RESTS = [60, 90, 120, 150, 180];

/** Sets, rep target, effort and rest for this workout only. */
export function PrescriptionSheet({ inst, exId, onClose }: { inst: WorkoutInstance; exId: string; onClose: () => void }) {
  const ex = inst.exercises.find((e) => e.id === exId);
  const [sets, setSets] = useState(ex?.prescribed.sets ?? 3);
  const [lo, setLo] = useState(ex?.prescribed.repRange[0] ?? 8);
  const [hi, setHi] = useState(ex?.prescribed.repRange[1] ?? 12);
  const [rir, setRir] = useState(ex?.prescribed.targetRir ?? 2);
  const [rest, setRest] = useState(ex?.prescribed.restSec ?? 90);
  if (!ex) return null;
  return (
    <BottomSheet visible onClose={onClose} title="Edit prescription"
      footer={<Button label="Save for this workout" onPress={() => { apex.editPrescription(inst.id, ex.id, { sets, repRange: [lo, Math.max(lo, hi)], targetRir: rir, restSec: rest }); onClose(); }} />}>
      <Txt v="bodySm" style={{ marginBottom: S.lg }}>{ex.name} · this workout only. Your template stays as written.</Txt>
      <Stepper label="Working sets" integer value={sets} step={1} min={1} max={20} onChange={setSets} />
      <View style={{ flexDirection: 'row', gap: S.md, marginTop: S.lg }}>
        <Stepper label="Reps min" integer value={lo} step={1} min={1} max={100} onChange={(n) => { setLo(n); if (n > hi) setHi(n); }} />
        <Stepper label="Reps max" integer value={hi} step={1} min={lo} max={100} onChange={setHi} />
      </View>
      <Txt v="overline" style={{ marginTop: S.lg, marginBottom: S.sm }}>Target RIR</Txt>
      <Segmented label="Target RIR" options={[0, 1, 2, 3, 4] as const} value={Math.min(4, rir) as 0} onChange={setRir} height={44} />
      <Txt v="overline" style={{ marginTop: S.lg, marginBottom: S.sm }}>Rest</Txt>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {RESTS.map((r) => <Chip key={r} label={restLabel(r)} selected={rest === r} onPress={() => setRest(r)} style={{ flex: 1 }} />)}
      </View>
    </BottomSheet>
  );
}

export function SwapSheet({ inst, exId, onClose }: { inst: SessionInstance; exId: string; onClose: () => void }) {
  const { data } = useApex();
  const w = useUnits();
  const [all, setAll] = useState(false);
  const ex = inst.exercises.find((e) => e.id === exId);
  if (!ex) return null;
  const options = inst.kind === 'gym' ? substitutesFor(ex.exerciseId) : plyoSubstitutesFor(ex.exerciseId);
  const done = resolvedCount(ex);
  const pick = (id: string) => { apex.substituteExercise(inst.id, exId, id); onClose(); };
  const original = ex.substitutedFromId;
  return (
    <BottomSheet visible onClose={onClose} title={`Substitute ${ex.name}`}>
      <Txt v="bodySm" style={{ marginBottom: S.sm }}>
        This session only — your template keeps {ex.substitutedFrom ?? ex.name}. The replacement keeps {done ? `the remaining ${Math.max(1, ex.prescribed.sets - done)}` : ex.prescribed.sets} sets{inst.kind === 'gym' ? ` of ${repRange((ex as GymEx).prescribed.repRange)}` : ''} and the same rest.
        {done ? ` ${done === 1 ? 'The set you logged stays' : `The ${done} sets you logged stay`} with ${ex.name}.` : ''}
      </Txt>
      {original && (
        <>
          <ListRow title={`Back to ${ex.substitutedFrom}`} subtitle="The exercise your template planned" left={<Icon name="swap" color={C.accent} />} onPress={() => pick(original)} />
          <Divider />
        </>
      )}
      {!all ? (
        <>
          <Txt v="overline" style={{ marginTop: S.md, marginBottom: 2 }}>Closest matches</Txt>
          {options.length === 0 && <Txt v="body" color={C.text2}>No close substitutes in the library.</Txt>}
          {options.filter((o) => o.id !== original).map((o, i) => {
            const last = 'primary' in o ? previousPerformance(data.instances, o.id, inst.id)?.sets : undefined;
            const sub = 'primary' in o
              ? `${MUSCLE_LABEL[o.primary]}${last?.length ? ` · last ${compactSets(last, o.unit, w)}` : ''}`
              : o.categories.join(' · ');
            return (
              <View key={o.id}>
                {i > 0 && <Divider />}
                <ListRow title={o.name} subtitle={sub} onPress={() => pick(o.id)} />
              </View>
            );
          })}
          <Button label="Any exercise" variant="ghost" size="md" icon="search" onPress={() => setAll(true)} style={{ marginTop: S.sm }} />
        </>
      ) : (
        <ExerciseSearch kind={inst.kind} exclude={[ex.exerciseId]} onPick={pick} />
      )}
    </BottomSheet>
  );
}

// ---------- quick log ----------

/**
 * For sets already done (forgot to log): every remaining set pre-filled from last time or
 * today's target, adjust, SAVE. Nothing is logged until SAVE.
 */
export function QuickLogSheet({ inst, exId, target, onSaved, onClose }: {
  inst: WorkoutInstance; exId: string; target?: { weight?: number; reps: number }; onSaved: () => void; onClose: () => void;
}) {
  const { data } = useApex();
  const ex = inst.exercises.find((e) => e.id === exId);
  const meta = gymExercise(ex?.exerciseId ?? '');
  const [rows, setRows] = useState(() => {
    if (!ex) return [];
    const prev = previousPerformance(data.instances, ex.exerciseId, inst.id)?.sets ?? [];
    const done = workingOf(ex);
    const n = Math.max(1, ex.prescribed.sets - done.length);
    const last = done[done.length - 1];
    return Array.from({ length: n }, (_, k) => {
      const p = prev[done.length + k] ?? prev[prev.length - 1];
      return { weight: last?.weight ?? p?.weight ?? target?.weight ?? 0, reps: last?.reps ?? p?.reps ?? target?.reps ?? ex.prescribed.repRange[1] };
    });
  });
  if (!ex) return null;
  const set = (k: number, patch: Partial<{ weight: number; reps: number }>) => setRows(rows.map((r, j) => (j === k ? { ...r, ...patch } : r)));
  const save = () => {
    if (apex.logSets(inst.id, ex.id, rows.map((r) => ({ kind: 'working' as const, weight: r.weight, reps: r.reps })))) onSaved();
  };
  const done = workingOf(ex).length;
  return (
    <BottomSheet visible onClose={onClose} title={ex.name}
      footer={<Button label={`Save ${rows.length} ${rows.length === 1 ? 'set' : 'sets'}`} icon="check" onPress={save} disabled={!rows.length} />}>
      <Txt v="bodySm" style={{ marginBottom: S.md }}>Quick log · sets you’ve already done. {done ? `${done} logged so far. ` : ''}Pre-filled from {done ? 'your last set' : 'last time'}.</Txt>
      {rows.map((r, k) => (
        <View key={k} style={styles.quickRow}>
          <Text style={styles.quickN}>{done + k + 1}</Text>
          <WeightStepper compact value={r.weight} incrementKg={meta.increment} onChange={(weight) => set(k, { weight })} />
          <Stepper label={meta.unit === 'sec' ? 'sec' : 'Reps'} value={r.reps} step={1} min={1} max={meta.unit === 'sec' ? 600 : 100} integer onChange={(reps) => set(k, { reps })} width={128} />
        </View>
      ))}
      <View style={{ flexDirection: 'row', gap: S.md, marginTop: S.sm }}>
        <Button label="Remove set" variant="ghost" size="md" disabled={rows.length <= 1} onPress={() => setRows(rows.slice(0, -1))} style={{ flex: 1 }} />
        <Button label="Add set" variant="secondary" size="md" icon="plus" onPress={() => setRows([...rows, rows[rows.length - 1] ?? { weight: 0, reps: 8 }])} style={{ flex: 1 }} />
      </View>
    </BottomSheet>
  );
}

const PLYO_METRIC = { jumpHeight: 'Height', height: 'Box', distance: 'Distance' } as const;

/** Quick log for jump work: every remaining set pre-filled from the prescription and last time. */
export function PlyoQuickLogSheet({ inst, exId, onSaved, onClose }: { inst: PlyometricInstance; exId: string; onSaved: () => void; onClose: () => void }) {
  const { data } = useApex();
  const ex = inst.exercises.find((e) => e.id === exId);
  const meta = plyoExercise(ex?.exerciseId ?? '');
  const [rows, setRows] = useState(() => {
    if (!ex) return [];
    const last = ex.logs[ex.logs.length - 1]?.value ?? previousPlyo(data.instances, ex.exerciseId, inst.id)?.logs.find((l) => l.value)?.value ?? 0;
    const n = Math.max(1, Math.ceil(ex.prescribed.sets - plyoSetsDone(ex.logs)));
    return Array.from({ length: n }, () => ({ reps: ex.prescribed.reps, value: last }));
  });
  if (!ex) return null;
  const set = (k: number, patch: Partial<{ reps: number; value: number }>) => setRows(rows.map((r, j) => (j === k ? { ...r, ...patch } : r)));
  const save = () => {
    if (apex.logPlyos(inst.id, ex.id, rows.map((r) => ({ reps: r.reps, value: meta.metric && r.value > 0 ? r.value : undefined })))) onSaved();
  };
  const done = Math.floor(plyoSetsDone(ex.logs));
  return (
    <BottomSheet visible onClose={onClose} title={ex.name}
      footer={<Button label={`Save ${rows.length} ${rows.length === 1 ? 'set' : 'sets'}`} icon="check" onPress={save} disabled={!rows.length} />}>
      <Txt v="bodySm" style={{ marginBottom: S.md }}>Quick log · sets you’ve already done{ex.prescribed.perSide ? ', reps per side' : ''}.</Txt>
      {rows.map((r, k) => (
        <View key={k} style={styles.quickRow}>
          <Text style={styles.quickN}>{done + k + 1}</Text>
          <Stepper label={ex.prescribed.perSide ? 'Reps/side' : 'Reps'} value={r.reps} step={1} min={1} max={100} integer onChange={(reps) => set(k, { reps })} />
          {meta.metric && <Stepper label={`${PLYO_METRIC[meta.metric]} cm`} value={r.value} step={1} min={0} max={1000} onChange={(value) => set(k, { value })} />}
        </View>
      ))}
      <View style={{ flexDirection: 'row', gap: S.md, marginTop: S.sm }}>
        <Button label="Remove set" variant="ghost" size="md" disabled={rows.length <= 1} onPress={() => setRows(rows.slice(0, -1))} style={{ flex: 1 }} />
        <Button label="Add set" variant="secondary" size="md" icon="plus" onPress={() => setRows([...rows, rows[rows.length - 1] ?? { reps: ex.prescribed.reps, value: 0 }])} style={{ flex: 1 }} />
      </View>
    </BottomSheet>
  );
}

// ---------- finish ----------

export function FinishSheet({ inst, onClose, onDone, onDiscard }: { inst: SessionInstance; onClose: () => void; onDone: (prs: PersonalRecord[]) => void; onDiscard: () => void }) {
  const p = sessionProgress(inst);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [rpe, setRpe] = useState<number | undefined>(undefined);
  const [note, setNote] = useState(inst.notes ?? '');
  const open = inst.exercises.filter((e) => e.status === 'pending' && resolvedCount(e) < e.prescribed.sets).length;
  if (confirmDiscard) {
    return (
      <BottomSheet visible onClose={() => setConfirmDiscard(false)} title="Discard session?"
        footer={
          <View style={{ gap: S.md }}>
            <Button label="Keep session" onPress={() => setConfirmDiscard(false)} />
            <Button label={`Discard ${loggedTotal(inst)} logged sets`} variant="danger" icon="trash" onPress={onDiscard} />
          </View>
        }>
        <Txt v="body" color={C.text2}>Everything logged in this session is deleted. This can’t be undone.</Txt>
      </BottomSheet>
    );
  }
  const finish = () => {
    if (note.trim() !== (inst.notes ?? '')) apex.setInstanceNotes(inst.id, note);
    onDone(apex.finishInstance(inst.id, { sessionRpe: rpe }));
  };
  return (
    <BottomSheet visible onClose={onClose} title="Finish workout?"
      footer={
        <View style={{ gap: S.md }}>
          <Button label="Finish & save" icon="check" onPress={finish} disabled={p.done === 0} />
          <View style={{ flexDirection: 'row', gap: S.md }}>
            <Button label="Keep training" variant="secondary" size="md" onPress={onClose} style={{ flex: 1 }} />
            <Button label="Discard" variant="ghost" size="md" onPress={() => (loggedTotal(inst) ? setConfirmDiscard(true) : onDiscard())} style={{ flex: 1 }} />
          </View>
        </View>
      }>
      <Txt v="body">{p.done} of {p.total} prescribed sets logged.{open ? ` ${open} exercise${open > 1 ? 's' : ''} unfinished — saved as-is.` : ''}</Txt>
      {p.done === 0 && <Txt v="bodySm" style={{ marginTop: S.sm }}>Log at least one set to save this session.</Txt>}
      {inst.kind === 'plyometric' && p.done > 0 && (
        <View style={{ marginTop: S.lg }}>
          <Txt v="overline" style={{ marginBottom: S.sm }}>How hard was it? · optional RPE</Txt>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {[5, 6, 7, 8, 9, 10].map((n) => <Chip key={n} label={String(n)} selected={rpe === n} onPress={() => setRpe(rpe === n ? undefined : n)} style={{ flex: 1 }} />)}
          </View>
        </View>
      )}
      <TextInput value={note} onChangeText={setNote} maxLength={300} placeholder="Workout note · optional — e.g. gym was crowded" placeholderTextColor={C.text3}
        style={[styles.input, { marginTop: S.lg }]} accessibilityLabel="Workout note" multiline />
    </BottomSheet>
  );
}

// ---------- completion ----------

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label}: ${value}${sub ? `, ${sub}` : ''}`}>
      <Txt v="overline">{label}</Txt>
      <Txt v="num" color={accent ? C.accent : C.text} numberOfLines={1}>{value}</Txt>
      {sub ? <Txt v="bodySm" color={C.text3}>{sub}</Txt> : null}
    </View>
  );
}

/** Concise: sets, time, volume vs last time, PRs, load. Details live in the summary. */
export function WorkoutComplete({ inst, onSummary, onDone }: { inst: SessionInstance; onSummary: () => void; onDone: () => void }) {
  const { data } = useApex();
  const insets = useSafeAreaInsets();
  const u = useUnits();
  const s = useMemo(() => workoutSummary(inst, data.instances, data.records, undefined, u), [inst, data.instances, data.records, u]);
  const [fade] = useState(() => new Animated.Value(0));
  useEffect(() => { Animated.timing(fade, { toValue: 1, duration: 360, useNativeDriver: Platform.OS !== 'web' }).start(); }, [fade]);
  const gym = inst.kind === 'gym';
  const change = s.volumeChange === undefined ? 'first time' : `${s.volumeChange >= 0 ? '+' : '−'}${Math.abs(s.volumeChange)}% vs last`;
  const status = statusOf(inst);
  // progression highlights: only where the engine actually recommends adding load
  const ups = s.progressions.filter((p) => p.rec.action === 'increase').slice(0, 3).map((p) => ({
    ...p, top: inst.kind === 'gym' ? Math.max(0, ...inst.exercises.filter((e) => e.exerciseId === p.exerciseId).flatMap((e) => workingOf(e).map((x) => x.weight))) : 0,
  }));
  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.bg }} contentContainerStyle={{ padding: GUTTER, paddingTop: insets.top + S.huge, paddingBottom: insets.bottom + S.xxl }}>
      <Animated.View style={{ opacity: fade, transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }}>
        <ApexMark size={24} />
        <Txt v="overline" style={{ marginTop: S.xxl }}>Workout complete</Txt>
        <Txt v="h1" accessibilityRole="header">{inst.templateName}</Txt>
        <View style={styles.statGrid}>
          <Stat label={gym ? 'Sets' : 'Contacts'} value={String(gym ? s.sets : s.volume)} sub={s.adapted ? `Apex prescribed ${s.plan.prescribed}` : undefined} />
          <Stat label="Time" value={duration(s.durationMs)} />
          <Stat label={gym ? 'Volume' : 'Sets'} value={gym ? wtu(s.volume, u) : String(s.sets)} sub={gym ? change : undefined} />
          <Stat label="PRs" value={String(s.prs.length)} accent={s.prs.length > 0} />
          <Stat label="Exercises" value={`${s.exercises.done} / ${s.exercises.total}`} />
          <Stat label="Training load" value={bandLabel[s.load.band]} sub="internal estimate" />
        </View>
        {(status.label !== 'As planned' || s.skipped.length > 0 || s.skippedSets > 0 || s.substitutions.length > 0) && (
          <View style={styles.notes}>
            {status.label !== 'As planned' && <Txt v="bodySm"><Text style={{ color: status.tone === 'accent' ? C.accent : C.text }}>{status.label}</Text>{inst.alternativeFor ? ` · instead of ${inst.alternativeFor.templateName}` : s.adapted ? ` · ${inst.decision.headline}` : ''}</Txt>}
            {s.skipped.length > 0 && <Txt v="bodySm">Skipped · {s.skipped.join(', ')}</Txt>}
            {s.skippedSets > 0 && <Txt v="bodySm">Skipped sets · {s.skippedSets}</Txt>}
            {s.substitutions.map((x) => <Txt key={x.from + x.to} v="bodySm">Substituted · {x.from} → {x.to}</Txt>)}
          </View>
        )}
        {ups.length > 0 && (
          <View style={{ marginTop: S.xl }}>
            <Txt v="overline" style={{ marginBottom: S.sm }}>Next time</Txt>
            {ups.map((p) => (
              <View key={p.exerciseId} style={styles.upRow}>
                <Txt v="body" numberOfLines={1} style={{ flex: 1 }}>{p.name}</Txt>
                <Txt v="label" color={C.accent}>{nextTimeText(p.rec, p.top, u)}</Txt>
              </View>
            ))}
          </View>
        )}
        {s.prs.length > 0 && (
          <ApexCard padded={false} style={{ marginTop: S.xl }}>
            {s.prs.map((pr, i) => (
              <View key={pr.id}>
                {i > 0 && <Divider />}
                <View style={styles.prRow}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Txt v="title" numberOfLines={1}>{pr.exerciseName}</Txt>
                    <Txt v="bodySm">{localize(pr.detail, u)}</Txt>
                  </View>
                  <PRBadge kind={pr.kind} />
                </View>
              </View>
            ))}
          </ApexCard>
        )}
        <ContextPrompt situation="complete" style={{ marginTop: S.xl }} />
        <View style={{ gap: S.md, marginTop: S.xxxl }}>
          <Button label="View summary" variant="secondary" onPress={onSummary} />
          <Button label="Done" onPress={onDone} />
        </View>
      </Animated.View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  preHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: S.sm, height: 56 },
  preFooter: { paddingHorizontal: GUTTER, paddingTop: S.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.lineStrong, backgroundColor: C.surface },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingVertical: S.md, minHeight: 56 },
  ssRow: { borderLeftWidth: 2, borderLeftColor: C.accent, paddingLeft: S.sm, marginLeft: -S.sm },
  ssHead: { marginTop: S.md, marginBottom: -4 },
  listIdx: { fontFamily: F.display, fontSize: 16, color: C.text2, width: 24, fontVariant: ['tabular-nums'] },
  glyphWrap: { width: 14, alignItems: 'center' },
  glyph: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: C.text3 },
  removedRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 40 },
  textBtn: { minHeight: 36, justifyContent: 'center', paddingHorizontal: S.sm },
  pva: { flexDirection: 'row', gap: S.md, marginVertical: S.lg },
  diffRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 44 },
  input: { minHeight: 48, borderRadius: R.md, backgroundColor: C.raised, color: C.text, padding: S.md, fontFamily: F.regular, fontSize: 15 },
  quickRow: { flexDirection: 'row', alignItems: 'flex-end', gap: S.sm, marginBottom: S.md },
  search: { flexDirection: 'row', alignItems: 'center', gap: S.sm, backgroundColor: C.raised, borderRadius: R.md, paddingHorizontal: S.md, height: 48, marginBottom: S.sm },
  searchInput: { flex: 1, color: C.text, fontFamily: F.regular, fontSize: 15, height: 48 },
  quickN: { width: 20, fontFamily: F.display, fontSize: 18, color: C.text2, marginBottom: 18, fontVariant: ['tabular-nums'] },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: S.lg, marginTop: S.xxl },
  notes: { gap: 4, marginTop: S.xl, paddingLeft: S.md, borderLeftWidth: 2, borderLeftColor: C.lineStrong },
  upRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 36 },
  altRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, marginTop: S.lg },
  stat: { width: '50%', paddingRight: S.md },
  prRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.lg },
});
