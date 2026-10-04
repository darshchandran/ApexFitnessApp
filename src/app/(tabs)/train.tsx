import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { ScheduleItem } from '@/domain/profile';
import { timeLabel } from '@/domain/schedule';
import type { SessionInstance } from '@/domain/types';
import { todayOverview, type SessionKind } from '@/services/apex';
import { apex, useApex } from '@/services/useApex';
import { BottomSheet } from '@/ui/BottomSheet';
import { activeExerciseCount, estimatedMinutes, prescribedVolume, reduction, sessionProgress, statusOf } from '@/ui/format';
import { Icon } from '@/ui/Icon';
import { go } from '@/ui/nav';
import { ApexCard, Button, Divider, EmptyState, ListRow, ProgressBar, Screen, SectionHeader, Segmented, StatusChip, Txt } from '@/ui/primitives';
import { AdaptationNote, PrescriptionRow } from '@/ui/training';
import { C, S } from '@/ui/theme';

/** "Basketball planned this morning · not logged yet" or "Basketball logged · Legs adjusted". */
function BasketballContext({ instance: i, planned, logged }: { instance: SessionInstance; planned?: ScheduleItem; logged: boolean }) {
  if (i.status !== 'planned') return null;
  const adjusted = logged && i.plan !== 'kept' && i.decision.outcome !== 'normal';
  if (!adjusted && (!planned || logged)) return null;
  const when = planned?.time && planned.time !== 'varies' ? ` ${timeLabel(planned.time).includes(':') ? `at ${timeLabel(planned.time)}` : `this ${planned.time}`}` : ' today';
  return (
    <View style={styles.context}>
      <Icon name="ball" size={16} color={adjusted ? C.accent : C.text2} />
      <Txt v="bodySm" style={{ flex: 1 }} color={C.text}>
        {adjusted ? `Basketball logged · ${i.templateName} adjusted` : `Basketball planned${when} · not logged yet`}
      </Txt>
      {!adjusted && (
        <Pressable onPress={go.practice} accessibilityRole="button" hitSlop={6} style={styles.contextBtn}>
          <Txt v="label" color={C.text}>Log practice</Txt>
        </Pressable>
      )}
    </View>
  );
}

function SessionBlock({ instance: i, kindLabel, alternativeName, bb }: { instance: SessionInstance; kindLabel: string; alternativeName?: string; bb: { planned?: ScheduleItem; logged: boolean } }) {
  const v = prescribedVolume(i);
  const p = sessionProgress(i);
  const planned = i.status === 'planned';
  const skipped = i.status === 'skipped';
  if (skipped) {
    return (
      <View>
        <View style={styles.blockHead}>
          <Txt v="overline">{kindLabel}</Txt>
          <StatusChip label="Recovery day" />
        </View>
        <Txt v="h1" style={{ marginTop: S.sm }} color={C.text2}>{i.templateName}</Txt>
        <Txt v="bodySm" style={{ marginTop: S.sm }}>Set aside for today. Nothing was logged and your rotation hasn’t moved.</Txt>
        <Button label="Bring it back" variant="secondary" size="md" onPress={() => apex.undoRecoveryDay(i.id)} style={{ marginTop: S.lg, alignSelf: 'flex-start' }} />
      </View>
    );
  }
  return (
    <View>
      <View style={styles.blockHead}>
        <Txt v="overline">{kindLabel}</Txt>
        <StatusChip
          label={i.status === 'completed' ? 'Completed' : i.status === 'active' ? 'In progress' : statusOf(i).label}
          tone={i.status === 'completed' ? 'solid' : i.status === 'active' ? 'accent' : statusOf(i).tone}
        />
      </View>
      <Txt v="h1" style={{ marginTop: S.sm }} accessibilityRole="header">{i.templateName}</Txt>
      <View style={styles.metaRow}>
        <Txt v="label" color={C.text}>{activeExerciseCount(i)} exercises</Txt>
        <Txt v="label">·</Txt>
        <Txt v="label" color={C.text}>{v.value} {v.unit}</Txt>
        <Txt v="label">·</Txt>
        <Txt v="label">~{estimatedMinutes(i)} min</Txt>
        {planned && i.plan !== 'kept' && i.decision.volumeFactor < 1 && (
          <Txt v="label" color={C.accent}>  Volume ↓ {reduction(i.decision.volumeFactor)}%</Txt>
        )}
      </View>
      {i.status === 'active' && <View style={{ marginTop: S.md }}><ProgressBar value={p.done / Math.max(1, p.total)} /></View>}
      <BasketballContext instance={i} planned={bb.planned} logged={bb.logged} />
      {planned && i.alternativeFor && (
        <View style={styles.altRow}>
          <Txt v="bodySm" style={{ flex: 1 }}>Instead of {i.alternativeFor.templateName}, as Apex suggested.</Txt>
          <Button label={`Back to ${i.alternativeFor.templateName}`} variant="secondary" size="md" onPress={() => apex.undoAlternative(i.id)} />
        </View>
      )}

      {planned && (
        <View style={{ marginTop: S.xl }}>
          <AdaptationNote decision={i.decision} plan={i.plan} controls
            onPlanMode={(m) => apex.setPlanMode(i.id, m)}
            alternativeName={alternativeName} onAlternative={alternativeName ? () => apex.useAlternative(i.id) : undefined}
            onRecovery={() => apex.takeRecoveryDay(i.id)} />
        </View>
      )}

      <ApexCard padded={false} style={{ marginTop: S.xl, paddingHorizontal: S.lg }}>
        {i.exercises.map((e, k) => (
          <View key={e.id}>
            {k > 0 && <Divider />}
            <PrescriptionRow index={k} instance={i} exercise={e} />
          </View>
        ))}
      </ApexCard>

      {i.status !== 'completed' && (
        <Button
          label={i.status === 'active' ? (i.kind === 'gym' ? 'Resume workout' : 'Resume plyometrics') : i.kind === 'gym' ? 'Start workout' : 'Start plyometrics'}
          icon="play"
          onPress={() => go.workout(i.id)}
          style={{ marginTop: S.lg }}
        />
      )}
      {i.status === 'completed' && <Button label="View session" variant="secondary" onPress={() => go.session(i.id)} style={{ marginTop: S.lg }} />}
    </View>
  );
}

export default function Train() {
  const { data } = useApex();
  const date = apex.today();
  const o = useMemo(() => todayOverview(data, date), [data, date]);
  // 'choose' = train a different template today; 'quick' = record a session already done
  const [picker, setPicker] = useState<'choose' | 'quick' | null>(null);
  const [kind, setKind] = useState<SessionKind | 'basketball'>('gym');
  const altName = (i?: SessionInstance) => {
    const id = i?.decision.alternativeTemplateId;
    return id ? [...data.templates, ...data.plyoTemplates].find((t) => t.id === id)?.name : undefined;
  };

  const sessions = [o.gym, o.plyo].filter(Boolean) as SessionInstance[];
  const bb = { planned: o.basketball.planned, logged: o.basketball.sessions.length > 0 };
  const otherActive = o.active && !sessions.some((s) => s.id === o.active!.id) ? o.active : undefined;

  return (
    <Screen>
      <Txt v="overline">Train</Txt>
      <Txt v="h2" style={{ marginTop: 2 }}>Today’s session</Txt>

      {otherActive && (
        <ListRow title={`Resume ${otherActive.templateName}`} subtitle="Started earlier — still open" onPress={() => go.workout(otherActive.id)} />
      )}

      {sessions.length === 0 && (
        <View style={{ marginTop: S.xxl }}>
          <EmptyState icon="program" title="Rest day" message="Nothing programmed today. Train anyway and Apex adapts it to your recent load." action="Choose session" onAction={() => setPicker('choose')} />
        </View>
      )}

      {o.gym && (
        <View style={{ marginTop: S.xxl }}>
          <SessionBlock instance={o.gym} kindLabel="Gym" alternativeName={altName(o.gym)} bb={bb} />
        </View>
      )}
      {o.plyo && (
        <View style={{ marginTop: S.huge }}>
          <SessionBlock instance={o.plyo} kindLabel="Plyometrics" alternativeName={altName(o.plyo)} bb={bb} />
        </View>
      )}

      <SectionHeader title="Something else" />
      <ApexCard padded={false}>
        {sessions.length > 0 && (
          <>
            <ListRow title="Choose a different session" subtitle="Any template, adapted to today’s load" onPress={() => setPicker('choose')} />
            <Divider />
          </>
        )}
        <ListRow title="Quick log" subtitle="Record a gym, jump or basketball session you’ve already done" onPress={() => setPicker('quick')} />
      </ApexCard>

      <BottomSheet visible={!!picker} onClose={() => setPicker(null)} title={picker === 'quick' ? 'Quick log' : 'Choose session'}>
        {picker === 'quick' && <Txt v="bodySm" style={{ marginBottom: S.md }}>Pick what you did. Sets are pre-filled from last time — adjust and save, exercise by exercise.</Txt>}
        <Segmented label="Session type" options={picker === 'quick' ? (['gym', 'plyometric', 'basketball'] as const) : (['gym', 'plyometric'] as const)} value={kind} onChange={setKind}
          format={(k) => (k === 'gym' ? 'GYM' : k === 'plyometric' ? 'PLYOS' : 'BASKETBALL')} />
        {kind === 'basketball' && (
          <Button label="Log basketball practice" icon="ball" onPress={() => { setPicker(null); go.practice(); }} style={{ marginTop: S.lg }} />
        )}
        <View style={{ marginTop: S.md }}>
          {(kind === 'gym' ? data.templates : kind === 'plyometric' ? data.plyoTemplates : []).map((t, k) => (
            <View key={t.id}>
              {k > 0 && <Divider />}
              <ListRow
                title={t.name}
                subtitle={`${t.exercises.length} exercises · ${t.tag}`}
                onPress={() => {
                  setPicker(null);
                  if (kind === 'basketball') return;
                  if (picker === 'quick') {
                    const id = apex.openTemplate(kind, t.id);
                    if (id) go.workout(id, { quick: true });
                  } else apex.planSession(kind, t.id);
                }}
              />
            </View>
          ))}
        </View>
      </BottomSheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  blockHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: S.sm, alignItems: 'center' },
  context: { flexDirection: 'row', alignItems: 'center', gap: S.sm, marginTop: S.md, paddingVertical: S.sm, paddingHorizontal: S.md, borderRadius: 10, backgroundColor: C.surface },
  contextBtn: { minHeight: 36, justifyContent: 'center', paddingHorizontal: S.sm },
  altRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: S.md, marginTop: S.lg },
});
