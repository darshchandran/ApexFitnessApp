import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { gymExercise, MUSCLE_LABEL } from '@/domain/catalog';
import { exerciseHistory, liveExercise, nextProgression } from '@/domain/logbook';
import { apex, useApex } from '@/services/useApex';
import { ExerciseBests, ExerciseGraph, ExerciseHistoryList, fmtEffort, fmtSet } from '@/ui/exercise';
import { repRange, restLabel, shortDate } from '@/ui/format';
import { localize, useUnits, wtu } from '@/ui/units';
import { go, goBack } from '@/ui/nav';
import { ApexCard, Button, Divider, IconButton, Segmented, StatusChip, Txt } from '@/ui/primitives';
import { C, GUTTER, S } from '@/ui/theme';
import { nextTimeText } from '@/ui/workout';

/** One exercise: what was lifted, when, the trend, and what Apex recommends next — TRACK / HISTORY / GRAPH. */
export default function ExerciseDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data } = useApex();
  const insets = useSafeAreaInsets();
  const meta = gymExercise(id);
  const unit = meta.unit;
  const scale = data.settings.effortScale;
  const u = useUnits();
  const [tab, setTab] = useState<'track' | 'history' | 'graph'>('track');
  const history = useMemo(() => exerciseHistory(data.instances, id), [data.instances, id]);

  // today's open or planned session with this exercise, if any
  const today = apex.today();
  const live = useMemo(() => liveExercise(data.instances, id, today), [data.instances, id, today]);

  const last = history[0];
  const lastWorking = last?.sets.filter((s) => s.kind === 'working') ?? [];
  const rec = nextProgression(history, live, id, u);
  const top = lastWorking.length ? Math.max(...lastWorking.map((s) => s.weight)) : 0;
  const todaySets = live?.ex.sets ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top }}>
      <View style={styles.header}>
        <IconButton icon="chevron-left" label="Back" onPress={goBack} />
        <Txt v="overline">Exercise</Txt>
        <View style={{ width: 48 }} />
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: insets.bottom + S.huge }}>
        <Txt v="h1" accessibilityRole="header" numberOfLines={3}>{meta.name}</Txt>
        <Txt v="label" style={{ marginTop: 4 }}>{MUSCLE_LABEL[meta.primary]}{meta.secondary?.length ? ` · ${meta.secondary.map((m) => MUSCLE_LABEL[m]).join(', ')}` : ''} · {history.length} {history.length === 1 ? 'session' : 'sessions'}</Txt>

        <View style={{ marginTop: S.lg }}><ExerciseBests history={history} unit={unit} /></View>

        <View style={{ marginTop: S.lg }}>
          <Segmented label="Exercise view" options={['track', 'history', 'graph'] as const} value={tab} onChange={setTab} format={(t) => t.toUpperCase()} height={40} />
        </View>

        {tab === 'track' && (
          <View style={{ marginTop: S.lg, gap: S.lg }}>
            {live ? (
              <ApexCard>
                <View style={styles.row}>
                  <Txt v="overline" color={C.text}>Today · {live.inst.templateName}</Txt>
                  <StatusChip label={live.inst.status === 'active' ? 'In progress' : 'Planned'} tone={live.inst.status === 'active' ? 'accent' : 'neutral'} />
                </View>
                <Txt v="title" style={{ marginTop: S.sm }}>
                  {live.ex.prescribed.sets} × {repRange(live.ex.prescribed.repRange, unit)} · {scale === 'rpe' ? `RPE ${10 - live.ex.prescribed.targetRir}` : `${live.ex.prescribed.targetRir} RIR`} · Rest {restLabel(live.ex.prescribed.restSec)}
                </Txt>
                {live.ex.templateSets > live.ex.prescribed.sets && live.inst.plan !== 'kept' && <Txt v="bodySm" color={C.accent}>Adapted {live.ex.templateSets} → {live.ex.prescribed.sets} sets · {live.inst.decision.headline}</Txt>}
                {todaySets.length > 0 && (
                  <View style={{ marginTop: S.sm }}>
                    {todaySets.map((s, k) => (
                      <View key={s.id} style={styles.line}>
                        <Txt v="label" style={{ width: 24 }} color={C.text3}>{s.kind === 'warmup' ? 'W' : k + 1 - todaySets.filter((x, j) => j < k && x.kind === 'warmup').length}</Txt>
                        <Txt v="num" style={{ flex: 1, fontSize: 20 }} color={s.kind === 'skipped' ? C.text3 : C.text}>{s.kind === 'skipped' ? 'Skipped' : fmtSet(s, unit, u)}</Txt>
                        <Txt v="label" color={C.text3}>{fmtEffort(s.rir, scale)}</Txt>
                      </View>
                    ))}
                  </View>
                )}
                <Button label={live.inst.status === 'active' ? 'Log in workout' : 'Open today’s workout'} icon="chevron-right" onPress={() => go.workout(live.inst.id, { ex: live.ex.id })} style={{ marginTop: S.md }} />
              </ApexCard>
            ) : (
              <Txt v="bodySm">Not in today’s workout. Start a template that includes it to log it.</Txt>
            )}

            <View>
              <Txt v="overline" style={{ marginBottom: S.sm }}>{live ? 'Today’s target' : 'Next time'}</Txt>
              <ApexCard>
                <Txt v="title">{live && rec.weight !== undefined ? `${wtu(rec.weight, u)} × ${rec.reps}${unit === 'sec' ? 's' : ''}` : nextTimeText(rec, top, u)}</Txt>
                <Txt v="bodySm" style={{ marginTop: 4 }}>{localize(rec.reason, u)}</Txt>
              </ApexCard>
            </View>

            {last && (
              <View>
                <Txt v="overline" style={{ marginBottom: S.sm }}>Previous · {shortDate(last.date)}</Txt>
                <ApexCard padded={false}>
                  {last.sets.map((s, k) => (
                    <View key={s.id}>
                      {k > 0 && <Divider />}
                      <View style={[styles.line, { paddingHorizontal: S.lg, minHeight: 44 }]}>
                        <Txt v="label" style={{ width: 24 }} color={C.text3}>{s.kind === 'warmup' ? 'W' : k + 1 - last.sets.filter((x, j) => j < k && x.kind === 'warmup').length}</Txt>
                        <Txt v="num" style={{ flex: 1, fontSize: 20 }} color={s.kind === 'warmup' ? C.text2 : s.kind === 'skipped' ? C.text3 : C.text}>{s.kind === 'skipped' ? 'Skipped' : fmtSet(s, unit, u)}</Txt>
                        <Txt v="label" color={C.text3}>{fmtEffort(s.rir, scale)}</Txt>
                      </View>
                    </View>
                  ))}
                </ApexCard>
                {last.notes ? <Txt v="bodySm" style={{ marginTop: S.sm }}>“{last.notes}”</Txt> : null}
              </View>
            )}
          </View>
        )}
        {tab === 'history' && <View style={{ marginTop: S.lg }}><ExerciseHistoryList history={history} unit={unit} effortScale={scale} onOpenSession={go.session} /></View>}
        {tab === 'graph' && <View style={{ marginTop: S.lg }}><ExerciseGraph history={history} unit={unit} /></View>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: S.sm, height: 56 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: S.sm },
  line: { flexDirection: 'row', alignItems: 'center', minHeight: 32, gap: S.sm },
});
