import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { gymExercise, plyoExercise } from '@/domain/catalog';
import { basketballLoad, basketballMovement } from '@/domain/load';
import { workoutSummary } from '@/domain/logbook';
import type { BasketballSession, SessionInstance } from '@/domain/types';
import { apex, useApex } from '@/services/useApex';
import { BottomSheet } from '@/ui/BottomSheet';
import { duration, longDate, statusOf } from '@/ui/format';
import { localize, useUnits, wt, wtu } from '@/ui/units';
import { go, goBack } from '@/ui/nav';
import { nextTimeText } from '@/ui/workout';
import { ApexCard, Button, Divider, EmptyState, IconButton, Metric, PRBadge, StatusChip, Txt } from '@/ui/primitives';
import { AdaptationNote } from '@/ui/training';
import { Icon } from '@/ui/Icon';
import { bandLabel, C, GUTTER, S } from '@/ui/theme';

const LEVEL = ['None', 'Low', 'Moderate', 'High'];

const topWeight = (i: SessionInstance, exerciseId: string) =>
  i.kind === 'gym' ? Math.max(0, ...i.exercises.filter((e) => e.exerciseId === exerciseId).flatMap((e) => e.sets.filter((x) => x.kind === 'working').map((x) => x.weight))) : 0;

export default function SessionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data } = useApex();
  const insets = useSafeAreaInsets();
  const inst = data.instances.find((i) => i.id === id);
  const bb = data.basketball.find((b) => b.id === id);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top }}>
      <View style={styles.header}>
        <IconButton icon="chevron-left" label="Back" onPress={() => goBack()} />
        <Txt v="overline">Session</Txt>
        <View style={{ width: 48 }} />
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: insets.bottom + S.huge }}>
        {inst ? <InstanceDetail inst={inst} /> : bb ? <BasketballDetail b={bb} /> : (
          <EmptyState title="Session not found" message="It may have been deleted." action="Back" onAction={() => goBack()} />
        )}
      </ScrollView>
    </View>
  );
}

function InstanceDetail({ inst }: { inst: SessionInstance }) {
  const { data } = useApex();
  const u = useUnits();
  const s = useMemo(() => workoutSummary(inst, data.instances, data.records, undefined, u), [inst, data.instances, data.records, u]);
  const prFor = (exerciseId: string) => s.prs.find((p) => p.exerciseId === exerciseId);
  const gym = inst.kind === 'gym';
  const done = inst.status === 'completed';
  return (
    <View>
      <Txt v="overline">{longDate(inst.date)}</Txt>
      <Txt v="h1" accessibilityRole="header">{inst.templateName}</Txt>
      <View style={{ flexDirection: 'row', gap: S.sm, marginTop: S.sm }}>
        <StatusChip label={inst.status === 'completed' ? 'Completed' : inst.status} tone={inst.status === 'completed' ? 'solid' : 'accent'} />
        <StatusChip label={statusOf(inst).label} tone={statusOf(inst).tone} />
      </View>
      <View style={styles.stats}>
        <View style={{ flex: 1 }}><Metric label="Duration" value={duration(s.durationMs)} /></View>
        <View style={{ flex: 1 }}><Metric label={gym ? 'Sets' : 'Contacts'} value={gym ? s.sets : s.volume} /></View>
        <View style={{ flex: 1.3 }}>
          {gym
            ? <Metric label="Volume" value={wt(s.volume, u)} unit={u} sub={s.volumeChange === undefined ? undefined : `${s.volumeChange >= 0 ? '+' : '−'}${Math.abs(s.volumeChange)}% vs last`} />
            : <Metric label="Sets" value={s.sets} />}
        </View>
      </View>
      <View style={styles.stats}>
        <View style={{ flex: 1 }}><Metric label="PRs" value={s.prs.length} color={s.prs.length ? C.accent : undefined} /></View>
        <View style={{ flex: 2.3 }}><Metric label="Training load" value={bandLabel[s.load.band]} sub="Internal estimate, not a medical measure" /></View>
      </View>

      <Txt v="overline" style={styles.section}>Plan vs actual</Txt>
      <ApexCard style={{ flexDirection: 'row', gap: S.md }}>
        <View style={{ flex: 1 }}><Metric label="Planned" value={s.plan.planned} /></View>
        <View style={{ flex: 1 }}><Metric label={inst.plan === 'kept' ? 'Kept plan' : 'Prescribed'} value={s.plan.prescribed} color={s.plan.prescribed !== s.plan.planned ? C.accent : undefined} /></View>
        <View style={{ flex: 1 }}><Metric label="Completed" value={s.plan.done} /></View>
        <Txt v="overline" style={{ alignSelf: 'flex-end' }}>{s.plan.unit}</Txt>
      </ApexCard>
      <View style={{ marginTop: S.lg }}><AdaptationNote decision={inst.decision} plan={inst.plan} /></View>
      {inst.alternativeFor && <Txt v="bodySm" style={{ marginTop: S.lg }}>Alternative: trained instead of {inst.alternativeFor.templateName}.</Txt>}
      {(s.skipped.length > 0 || s.skippedSets > 0 || s.substitutions.length > 0 || s.removed.length > 0) && (
        <View style={{ marginTop: S.lg, gap: 4 }}>
          {s.removed.length > 0 && <Txt v="bodySm">Removed by Apex: {s.removed.join(', ')}</Txt>}
          {s.skipped.length > 0 && <Txt v="bodySm">Skipped: {s.skipped.join(', ')}</Txt>}
          {s.skippedSets > 0 && <Txt v="bodySm">Skipped sets: {s.skippedSets}</Txt>}
          {s.substitutions.map((x) => <Txt key={x.from + x.to} v="bodySm">Substituted: {x.from} → {x.to}</Txt>)}
        </View>
      )}
      {inst.notes ? <Txt v="body" style={{ marginTop: S.lg }}>“{inst.notes}”</Txt> : null}

      {done && s.progressions.length > 0 && (
        <>
          <Txt v="overline" style={styles.section}>Next time</Txt>
          <ApexCard padded={false}>
            {s.progressions.map((p, i) => (
              <View key={p.exerciseId}>
                {i > 0 && <Divider />}
                <Pressable onPress={() => go.exercise(p.exerciseId)} accessibilityRole="button" accessibilityLabel={`${p.name}: next time ${nextTimeText(p.rec, topWeight(inst, p.exerciseId), u)}. ${localize(p.rec.reason, u)}`}
                  style={({ pressed }) => [styles.ex, pressed && { backgroundColor: C.pressed }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
                    <Txt v="title" style={{ flex: 1 }} numberOfLines={1}>{p.name}</Txt>
                    <Txt v="label" color={p.rec.action === 'increase' ? C.accent : C.text}>{nextTimeText(p.rec, topWeight(inst, p.exerciseId), u)}</Txt>
                  </View>
                  <Txt v="bodySm">{localize(p.rec.reason, u)}</Txt>
                </Pressable>
              </View>
            ))}
          </ApexCard>
        </>
      )}

      <Txt v="overline" style={styles.section}>Performance</Txt>
      <ApexCard padded={false}>
        {inst.exercises.filter((e) => e.status !== 'removed').map((e, i) => {
          const pr = prFor(e.exerciseId);
          return (
            <View key={e.id}>
              {i > 0 && <Divider />}
              <View style={styles.ex}>
                <Pressable onPress={inst.kind === 'gym' ? () => go.exercise(e.exerciseId) : undefined} disabled={inst.kind !== 'gym'} accessibilityRole={inst.kind === 'gym' ? 'button' : undefined}
                  accessibilityLabel={inst.kind === 'gym' ? `${e.name}: history and graph` : e.name}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm, minHeight: 32 }}>
                  <Txt v="title" style={{ flex: 1 }} numberOfLines={2}>{e.name}</Txt>
                  {pr && <PRBadge kind={pr.kind} />}
                  {e.status === 'skipped' && <StatusChip label="Skipped" />}
                  {inst.kind === 'gym' && <Icon name="chevron-right" size={16} color={C.text3} />}
                </Pressable>
                {e.substitutedFrom && <Txt v="bodySm" color={C.text3}>Substituted for {e.substitutedFrom} this session</Txt>}
                {inst.kind === 'gym' && 'sets' in e && (
                  e.sets.length ? e.sets.map((set, k) => (
                    <View key={set.id}>
                      <View style={styles.setLine}>
                        <Txt v="label" style={{ width: 28 }} color={C.text3}>{set.kind === 'warmup' ? 'W' : k + 1 - e.sets.filter((x, j) => j < k && x.kind === 'warmup').length}</Txt>
                        {set.kind === 'skipped'
                          ? <Txt v="body" style={{ flex: 1 }} color={C.text3}>Skipped</Txt>
                          : <Txt v="body" style={{ flex: 1 }} color={set.kind === 'warmup' ? C.text2 : C.text}>{wtu(set.weight, u)} × {set.reps}{gymExercise(e.exerciseId).unit === 'sec' ? 's' : ''}{set.kind === 'warmup' ? '  · warm-up' : ''}</Txt>}
                        {set.rir !== undefined && <Txt v="label">{data.settings.effortScale === 'rpe' ? `RPE ${10 - set.rir}` : `${set.rir} RIR`}</Txt>}
                      </View>
                      {set.note ? <Txt v="bodySm" color={C.text3} style={{ marginLeft: 28 }}>{set.note}</Txt> : null}
                    </View>
                  )) : <Txt v="bodySm">Not logged</Txt>
                )}
                {inst.kind === 'plyometric' && 'logs' in e && (
                  e.logs.length ? e.logs.map((l, k) => (
                    <View key={l.id} style={styles.setLine}>
                      <Txt v="label" style={{ width: 28 }} color={C.text3}>{k + 1}</Txt>
                      <Txt v="body" style={{ flex: 1 }}>{l.reps}{l.side ? ` reps · ${l.side === 'L' ? 'left' : 'right'}` : e.prescribed.perSide ? ' reps / side' : ' reps'}</Txt>
                      {l.value !== undefined && <Txt v="label">{l.value} cm {plyoExercise(e.exerciseId).metric === 'distance' ? 'distance' : 'height'}</Txt>}
                    </View>
                  )) : <Txt v="bodySm">Not logged</Txt>
                )}
                {e.notes ? <Txt v="bodySm" style={{ marginTop: 4 }}>“{e.notes}”</Txt> : null}
              </View>
            </View>
          );
        })}
      </ApexCard>
    </View>
  );
}

function BasketballDetail({ b }: { b: BasketballSession }) {
  const [confirm, setConfirm] = useState(false);
  const l = basketballLoad(b);
  const m = basketballMovement(b);
  const rows: [string, string][] = [
    ['Session type', b.sessionType ? b.sessionType[0].toUpperCase() + b.sessionType.slice(1) : '—'],
    ['Jumping', LEVEL[m.jumping]], ['Sprinting', LEVEL[m.sprinting]], ['Change of direction', LEVEL[m.changeOfDirection]], ['Running', LEVEL[m.running]],
    ['Lower-body fatigue', b.lowerFatigue !== undefined ? LEVEL[b.lowerFatigue] : '—'],
    ['Upper-body fatigue', b.upperFatigue !== undefined ? LEVEL[b.upperFatigue] : '—'],
  ];
  return (
    <View>
      <Txt v="overline">{longDate(b.date)}</Txt>
      <Txt v="h1" accessibilityRole="header">Basketball</Txt>
      <View style={styles.stats}>
        <View style={{ flex: 1 }}><Metric label="Duration" value={b.durationMin} unit="min" /></View>
        <View style={{ flex: 1 }}><Metric label="RPE" value={b.rpe} /></View>
        <View style={{ flex: 1 }}><Metric label="Load" value={Math.round(l.total)} /></View>
      </View>
      <Txt v="bodySm" style={{ marginTop: S.md }}>{Math.round(l.lowerShare * 100)}% lower-body · ≈{Math.round(l.jumps)} landings. Internal training-load estimate, not a physiological measurement.</Txt>
      <ApexCard padded={false} style={{ marginTop: S.xl }}>
        {rows.map(([k, v], i) => (
          <View key={k}>
            {i > 0 && <Divider />}
            <View style={styles.kv}><Txt v="body" color={C.text2}>{k}</Txt><Txt v="body">{v}</Txt></View>
          </View>
        ))}
      </ApexCard>
      {b.notes ? <Txt v="body" style={{ marginTop: S.lg }}>“{b.notes}”</Txt> : null}
      <Button label="Delete practice" variant="ghost" icon="trash" onPress={() => setConfirm(true)} style={{ marginTop: S.xxl }} />
      <BottomSheet visible={confirm} onClose={() => setConfirm(false)} title="Delete practice?"
        footer={<Button label="Delete" variant="danger" onPress={() => { apex.deleteBasketball(b.id); setConfirm(false); goBack(); }} />}>
        <Txt v="body" color={C.text2}>Today’s unstarted sessions will be re-adapted without it.</Txt>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: S.sm, height: 56 },
  stats: { flexDirection: 'row', gap: S.md, marginTop: S.xl },
  section: { marginTop: S.xxl, marginBottom: S.md },
  ex: { padding: S.lg, gap: 6 },
  setLine: { flexDirection: 'row', alignItems: 'center', minHeight: 28 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: S.lg, minHeight: 48 },
});
