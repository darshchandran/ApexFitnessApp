import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { basketballLoad } from '@/domain/load';
import type { Units } from '@/domain/profile';
import type { SessionInstance } from '@/domain/types';
import { todayOverview } from '@/services/apex';
import { apex, useApex } from '@/services/useApex';
import { BottomSheet } from '@/ui/BottomSheet';
import { ApexMark } from '@/ui/Brand';
import { activeExerciseCount, estimatedMinutes, longDate, prescribedVolume, reduction, sessionProgress, sessionSummary, statusOf, weekdayName } from '@/ui/format';
import { Icon } from '@/ui/Icon';
import { timeLabel } from '@/domain/schedule';
import { go } from '@/ui/nav';
import { useUnits } from '@/ui/units';
import { ContextPrompt } from '@/ui/context';
import { ApexCard, Button, Divider, EmptyState, IconButton, ProgressBar, Screen, SectionHeader, Segmented, StatusChip, Stepper, Txt } from '@/ui/primitives';
import { AdaptationNote, SessionRow, TrainingLoadCard, basketballRowProps, instanceRowProps } from '@/ui/training';
import { bandLabel, C, S, type Tone } from '@/ui/theme';

function sessionState(i: SessionInstance | undefined, scheduled = false): { chip: string; tone: Tone } {
  if (!i) return { chip: scheduled ? 'Not scheduled' : 'Rest day', tone: 'neutral' };
  if (i.status === 'completed') return { chip: 'Completed', tone: 'solid' };
  if (i.status === 'active') return { chip: 'In progress', tone: 'accent' };
  const s = statusOf(i);
  return { chip: s.label, tone: s.tone };
}

function sessionLine(i: SessionInstance, u: Units) {
  if (i.status === 'completed') return sessionSummary(i, u);
  if (i.status === 'skipped') return 'Set aside for today — bring it back from Train.';
  if (i.alternativeFor && i.status === 'planned') return `Instead of ${i.alternativeFor.templateName} · ${activeExerciseCount(i)} exercises`;
  if (i.status === 'active') {
    const p = sessionProgress(i);
    return `${p.done} of ${p.total} sets logged — tap to resume`;
  }
  const v = prescribedVolume(i);
  const base = `${activeExerciseCount(i)} exercises · ${v.value} ${v.unit}`;
  if (i.status === 'planned' && i.plan !== 'kept' && i.decision.outcome !== 'normal' && i.decision.volumeFactor < 1) {
    return `Volume ↓ ${reduction(i.decision.volumeFactor)}% · ${base}`;
  }
  return i.status === 'planned' ? `${base} · ~${estimatedMinutes(i)} min` : base;
}

function TodayRow({ label, title, line, chip, tone, onPress, right }: { label: string; title: string; line: string; chip: string; tone: Tone; onPress: () => void; right?: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label}: ${title}. ${chip}. ${line}`}
      style={({ pressed }) => [styles.todayRow, pressed && { backgroundColor: C.pressed }]}>
      <View style={styles.todayHead}>
        <Txt v="overline">{label}</Txt>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
          {right ? <Txt v="label" color={C.text}>{right}</Txt> : null}
          <StatusChip label={chip} tone={tone} />
        </View>
      </View>
      <Txt v="h3" numberOfLines={1} style={{ marginTop: 6 }}>{title}</Txt>
      <Txt v="bodySm" numberOfLines={2} style={{ marginTop: 2 }} color={tone === 'accent' && chip === 'Adapted' ? C.accent : C.text2}>{line}</Txt>
    </Pressable>
  );
}

export default function Home() {
  const { data } = useApex();
  const u = useUnits();
  const date = apex.today();
  const o = useMemo(() => todayOverview(data, date), [data, date]);
  const [checkIn, setCheckIn] = useState(false);

  useFocusEffect(useCallback(() => { apex.refreshToday(); }, []));

  const bb = o.basketball.sessions;
  const lastBb = bb[bb.length - 1];
  const bbLoad = lastBb && basketballLoad(lastBb);
  const adapted = [o.gym, o.plyo].find((i) => i && i.status === 'planned' && i.plan !== 'kept' && i.decision.outcome !== 'normal');
  const alternativeName = adapted?.decision.alternativeTemplateId
    ? [...data.templates, ...data.plyoTemplates].find((t) => t.id === adapted.decision.alternativeTemplateId)?.name
    : undefined;

  const next = o.active ?? [o.gym, o.plyo].find((i) => i && i.status === 'planned');
  const startLabel = o.active ? `Resume ${o.active.kind === 'gym' ? 'workout' : 'plyos'}` : next ? `Start ${next.kind === 'gym' ? 'workout' : 'plyos'}` : 'Choose session';
  // start = today's overview (previous performance, what Apex changed); LOG ALL there starts it
  const onStart = () => (o.active ? go.workout(o.active.id) : next ? go.workout(next.id) : go.train());

  const recent = useMemo(() => {
    const items = [
      ...data.instances.filter((i) => i.status === 'completed').map((i) => ({ at: i.completedAt ?? i.date, row: instanceRowProps(i, u), id: i.id })),
      ...data.basketball.map((b) => ({ at: b.loggedAt, row: basketballRowProps(b), id: b.id })),
    ];
    return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 4);
  }, [data.instances, data.basketball, u]);

  return (
    <Screen>
      <View style={styles.top}>
        <ApexMark size={20} />
        <IconButton icon="user" label="Profile" onPress={go.settings} filled size={40} />
      </View>

      <Txt v="overline" style={{ marginTop: S.xl }}>Today</Txt>
      <Txt v="h1" accessibilityRole="header">{weekdayName(date)}</Txt>
      <Txt v="label" style={{ marginTop: 2 }}>{longDate(date).replace(/^\w+,?\s/, '')}</Txt>

      <ContextPrompt situation="home" style={{ marginTop: S.xl }} />

      {o.active && (
        <Pressable onPress={() => go.workout(o.active!.id)} accessibilityRole="button" style={styles.resume}>
          <View style={{ flex: 1, gap: 6 }}>
            <Txt v="overline" color={C.accent}>In progress</Txt>
            <Txt v="title">{o.active.templateName}</Txt>
            <ProgressBar value={sessionProgress(o.active).done / Math.max(1, sessionProgress(o.active).total)} />
          </View>
          <Icon name="chevron-right" color={C.text2} />
        </Pressable>
      )}

      <SectionHeader title="Today's training" />
      <ApexCard padded={false}>
        <TodayRow
          label="Basketball"
          right={timeLabel(o.basketball.planned?.time === 'varies' ? undefined : o.basketball.planned?.time)}
          title={lastBb ? `${lastBb.durationMin} min · RPE ${lastBb.rpe}` : o.basketball.planned ? o.basketball.planned.label ?? 'Practice' : 'Not scheduled'}
          line={lastBb ? `Load ${Math.round(bbLoad!.total)} · ${bandLabel[o.stress.bands.lower]} lower-body load` : o.basketball.planned ? 'Planned — it counts once you log it.' : 'Log today’s basketball session to adapt tonight’s training.'}
          chip={lastBb ? 'Logged' : o.basketball.planned ? 'Planned' : 'Optional'}
          tone={lastBb ? 'solid' : 'neutral'}
          onPress={go.practice}
        />
        <Divider />
        <TodayRow
          label="Gym"
          title={o.gym?.templateName ?? (o.day.gym ? '—' : 'Rest')}
          line={o.gym ? sessionLine(o.gym, u) : 'Nothing programmed. Recovery is part of the plan.'}
          {...sessionState(o.gym, !!o.day.gym)}
          onPress={() => (o.gym?.status === 'active' ? go.workout(o.gym.id) : go.train())}
        />
        <Divider />
        <TodayRow
          label="Plyometrics"
          title={o.plyo?.templateName ?? 'None'}
          line={o.plyo ? sessionLine(o.plyo, u) : 'No jump work scheduled today.'}
          {...sessionState(o.plyo, true)}
          onPress={() => (o.plyo?.status === 'active' ? go.workout(o.plyo.id) : go.train())}
        />
      </ApexCard>

      {adapted && (
        <View style={{ marginTop: S.xl }}>
          <AdaptationNote decision={adapted.decision} plan={adapted.plan} controls
            onPlanMode={(m) => apex.setPlanMode(adapted.id, m)}
            alternativeName={alternativeName} onAlternative={alternativeName ? () => apex.useAlternative(adapted.id) : undefined}
            onRecovery={() => apex.takeRecoveryDay(adapted.id)} />
        </View>
      )}

      <View style={styles.actions}>
        <Button label="Log practice" variant="secondary" onPress={go.practice} style={{ flex: 1, paddingHorizontal: S.md }} />
        <Button label={startLabel} onPress={onStart} style={{ flex: 1.35, paddingHorizontal: S.md }} />
      </View>

      <SectionHeader title="Training status" />
      <TrainingLoadCard readiness={o.readiness} load={o.load} week={o.week} bands={o.stress.bands} onCheckIn={() => setCheckIn(true)} />

      <SectionHeader title="Recent" />
      {recent.length ? (
        <ApexCard padded={false}>
          {recent.map((r, i) => (
            <View key={r.id}>
              {i > 0 && <Divider inset={64} />}
              <SessionRow {...r.row} onPress={() => go.session(r.id)} />
            </View>
          ))}
        </ApexCard>
      ) : (
        <EmptyState mark title="No workout history" message="Your training history starts here." action={startLabel} onAction={onStart} />
      )}

      <CheckInSheet visible={checkIn} onClose={() => setCheckIn(false)} initial={o.recovery} />
    </Screen>
  );
}

function CheckInSheet({ visible, onClose, initial }: { visible: boolean; onClose: () => void; initial?: { sleepHours: number; soreness: number; energy: number } }) {
  const [sleep, setSleep] = useState(initial?.sleepHours ?? 7.5);
  const [soreness, setSoreness] = useState(initial?.soreness ?? 2);
  const [energy, setEnergy] = useState(initial?.energy ?? 4);
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Morning check-in"
      footer={<Button label="Save check-in" onPress={() => { apex.logRecovery({ sleepHours: sleep, soreness, energy }); onClose(); }} />}>
      <Txt v="bodySm" style={{ marginBottom: S.lg }}>Ten seconds. Feeds readiness and tonight’s adaptation.</Txt>
      <Stepper label="Sleep" unit="hours" value={sleep} step={0.5} min={0} max={14} onChange={setSleep} />
      <Txt v="overline" style={{ marginTop: S.xl, marginBottom: S.sm }}>Soreness · 1 none – 5 severe</Txt>
      <Segmented label="Soreness" options={[1, 2, 3, 4, 5] as const} value={soreness as 1} onChange={setSoreness} height={52} />
      <Txt v="overline" style={{ marginTop: S.xl, marginBottom: S.sm }}>Energy · 1 drained – 5 great</Txt>
      <Segmented label="Energy" options={[1, 2, 3, 4, 5] as const} value={energy as 1} onChange={setEnergy} height={52} />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  resume: { flexDirection: 'row', alignItems: 'center', gap: S.md, marginTop: S.xl, padding: S.lg, borderRadius: 16, borderWidth: 1, borderColor: C.accent, backgroundColor: C.surface },
  todayRow: { paddingHorizontal: 16, paddingVertical: 14 },
  todayHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 24 },
  actions: { flexDirection: 'row', gap: S.md, marginTop: S.xl },
});
