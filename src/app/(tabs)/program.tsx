import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { weeklySchedule } from '@/domain/profile';
import { projectWeek, rotationCount, WEEKDAYS } from '@/domain/schedule';
import type { Rotation } from '@/domain/types';
import { addDays, uid } from '@/domain/util';
import { apex, useApex } from '@/services/useApex';
import { BottomSheet } from '@/ui/BottomSheet';
import { Icon } from '@/ui/Icon';
import { planVsActual, shortDate } from '@/ui/format';
import { go } from '@/ui/nav';
import { ApexCard, Divider, EmptyState, ListRow, Screen, SectionHeader, StatusChip, Txt } from '@/ui/primitives';
import { DayEditor, entryText } from '@/ui/schedule';
import { TemplateCard } from '@/ui/training';
import { C, F, R, S } from '@/ui/theme';

function Num({ label, value, accent }: { label: string; value: number | string; accent?: boolean }) {
  return (
    <View>
      <Txt v="overline">{label}</Txt>
      <Txt v="num" color={accent ? C.accent : C.text}>{value}</Txt>
    </View>
  );
}

export default function Program() {
  const { data } = useApex();
  const date = apex.today();
  const week = useMemo(() => projectWeek(data.plan, data.instances, date), [data.plan, data.instances, date]);
  const [dayIdx, setDayIdx] = useState<number | null>(null);
  const [rotId, setRotId] = useState<string | null>(null);
  const name = (id?: string) => (id ? [...data.templates, ...data.plyoTemplates].find((t) => t.id === id)?.name : undefined);
  const rotName = (id?: string) => data.plan.rotations.find((r) => r.id === id)?.name;
  const recent = useMemo(() => data.instances
    .filter((i) => i.date >= addDays(date, -6) && i.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)), [data.instances, date]);
  const todayGym = week.find((w) => w.date === date)?.gym?.templateId;
  const todayPlyo = week.find((w) => w.date === date)?.plyo?.templateId;

  return (
    <Screen>
      <Txt v="overline">Current program</Txt>
      <Txt v="h1" style={{ marginTop: 2 }} accessibilityRole="header">{data.plan.name}</Txt>
      <Txt v="bodySm" style={{ marginTop: 4 }}>Your program. Apex adapts each day to load — it never rewrites the templates.</Txt>

      <ApexCard padded={false} style={{ marginTop: S.xl }}>
        {week.map((w, i) => {
          const today = w.date === date;
          const gym = w.gym ? (w.gym.templateId ? name(w.gym.templateId) : `${rotName(w.gym.rotationId)} rotation`) : undefined;
          const activities = weeklySchedule(data)[i].filter((e) => e.enabled && e.source === 'schedule').map((e) => entryText(data, e));
          const extras = [w.plyo?.templateId && name(w.plyo.templateId), ...activities].filter(Boolean).join(' · ');
          const rest = !w.gym && !w.plyo;
          return (
            <View key={w.date}>
              {i > 0 && <Divider />}
              <Pressable onPress={() => setDayIdx(i)} accessibilityRole="button"
                accessibilityLabel={`${WEEKDAYS[i]}: ${rest ? 'rest' : gym ?? ''}${extras ? `, ${extras}` : ''}${today ? ', today' : ''}. Edit`}
                style={({ pressed }) => [styles.day, pressed && { backgroundColor: C.pressed }]}>
                {today && <View style={styles.todayBar} />}
                <Txt v="overline" color={today ? C.text : C.text3} style={styles.dow}>{WEEKDAYS[i]}</Txt>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
                    <Txt v="title" color={rest ? C.text3 : C.text} numberOfLines={1}>{rest ? 'Rest' : gym ?? '—'}</Txt>
                    {w.gym?.done && <Icon name="check" size={16} color={C.text2} strokeWidth={2.4} />}
                  </View>
                  {!!extras && <Txt v="bodySm" numberOfLines={1}>{rest ? extras : `+ ${extras}`}</Txt>}
                </View>
                {today && <StatusChip label="Today" tone="accent" />}
                <Icon name="chevron-right" size={18} color={C.text3} />
              </Pressable>
            </View>
          );
        })}
      </ApexCard>

      <SectionHeader title="Plan vs actual · 7 days" />
      {recent.length ? (
        <ApexCard padded={false}>
          {recent.map((i, k) => {
            const v = planVsActual(i);
            const status = i.status === 'completed' ? 'Completed' : i.status === 'active' ? 'In progress' : i.status === 'skipped' ? 'Recovery day' : 'Planned';
            const adapted = i.plan !== 'kept' && v.prescribed !== v.planned;
            return (
              <View key={i.id}>
                {k > 0 && <Divider />}
                <Pressable onPress={() => (i.status === 'completed' ? go.session(i.id) : i.status === 'active' ? go.workout(i.id) : go.train())} accessibilityRole="button"
                  accessibilityLabel={`${i.templateName}, ${shortDate(i.date)}. Planned ${v.planned} ${v.unit}, Apex ${i.plan === 'kept' ? 'plan kept' : v.prescribed}, done ${v.done}. ${status}`}
                  style={({ pressed }) => [styles.pva, pressed && { backgroundColor: C.pressed }]}>
                  <View style={styles.pvaHead}>
                    <Txt v="title" numberOfLines={1} style={{ flex: 1 }}>{i.templateName}</Txt>
                    <Txt v="label">{shortDate(i.date)}</Txt>
                  </View>
                  <View style={styles.pvaNums}>
                    <Num label="Planned" value={v.planned} />
                    <Num label={i.plan === 'kept' ? 'Kept plan' : 'Apex'} value={i.plan === 'kept' ? v.planned : v.prescribed} accent={adapted} />
                    <Num label="Done" value={i.status === 'completed' || i.status === 'active' ? v.done : '—'} />
                    <Txt v="overline" style={{ marginLeft: 'auto', alignSelf: 'flex-end', marginBottom: 2 }}>{v.unit}</Txt>
                  </View>
                  {adapted && <Txt v="bodySm" numberOfLines={2}>{i.decision.headline}</Txt>}
                  <StatusChip label={status} tone={i.status === 'completed' ? 'solid' : i.status === 'active' ? 'accent' : 'neutral'} style={{ marginTop: 2 }} />
                </Pressable>
              </View>
            );
          })}
        </ApexCard>
      ) : (
        <EmptyState title="Nothing this week yet" message="Planned, prescribed and completed volume for each session shows here." />
      )}

      <SectionHeader title="Rotations" action="+ New" onAction={() => {
        const r: Rotation = { id: uid('rot'), name: 'New rotation', templateIds: [] };
        apex.saveRotation(r);
        setRotId(r.id);
      }} />
      <ApexCard padded={false}>
        {data.plan.rotations.map((r, i) => {
          const next = r.templateIds.length ? r.templateIds[rotationCount(data.instances, r.id) % r.templateIds.length] : undefined;
          return (
            <View key={r.id}>
              {i > 0 && <Divider />}
              <ListRow title={r.name} subtitle={`${r.templateIds.map((t) => name(t)).join(' → ') || 'No templates'}${next ? ` · next: ${name(next)}` : ''}`} onPress={() => setRotId(r.id)} />
            </View>
          );
        })}
      </ApexCard>

      <SectionHeader title="Gym templates" action="+ New" onAction={() => go.template(apex.createTemplate('gym', 'New workout'))} />
      <View style={{ gap: S.md }}>
        {data.templates.map((t) => <TemplateCard key={t.id} template={t} badge={t.id === todayGym ? 'Today' : undefined} onPress={() => go.template(t.id)} />)}
      </View>

      <SectionHeader title="Plyometric templates" action="+ New" onAction={() => go.template(apex.createTemplate('plyometric', 'New plyo session'))} />
      <View style={{ gap: S.md }}>
        {data.plyoTemplates.map((t) => <TemplateCard key={t.id} template={t} badge={t.id === todayPlyo ? 'Today' : undefined} onPress={() => go.template(t.id)} />)}
      </View>

      {dayIdx !== null && <DayEditor index={dayIdx} onClose={() => setDayIdx(null)} />}
      {rotId && <RotationEditor id={rotId} onClose={() => setRotId(null)} />}
    </Screen>
  );
}

function RotationEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useApex();
  const rot = data.plan.rotations.find((r) => r.id === id);
  const [nameText, setNameText] = useState(rot?.name ?? '');
  if (!rot) return null;
  const toggle = (tid: string) =>
    apex.saveRotation({ ...rot, templateIds: rot.templateIds.includes(tid) ? rot.templateIds.filter((x) => x !== tid) : [...rot.templateIds, tid] });
  return (
    <BottomSheet visible onClose={onClose} title="Rotation">
      <TextInput value={nameText} onChangeText={(n) => { setNameText(n); if (n.trim()) apex.saveRotation({ ...rot, name: n.trim() }); }}
        maxLength={30} returnKeyType="done" style={styles.nameInput} accessibilityLabel="Rotation name" />
      <Txt v="bodySm" style={{ marginBottom: S.md }}>Templates alternate in the order you pick them: V1 → V2 → V1 … The pointer moves when a session from this rotation is completed.</Txt>
      {data.templates.map((t, i) => {
        const pos = rot.templateIds.indexOf(t.id);
        return (
          <View key={t.id}>
            {i > 0 && <Divider />}
            <ListRow title={t.name} subtitle={t.tag} onPress={() => toggle(t.id)}
              right={pos >= 0 ? <View style={styles.order}><Txt v="label" color={C.bg} style={{ fontFamily: F.semibold }}>{pos + 1}</Txt></View> : <View style={[styles.order, { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.line }]} />} />
          </View>
        );
      })}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  day: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingVertical: S.md, paddingHorizontal: S.lg, minHeight: 64 },
  todayBar: { position: 'absolute', left: 0, top: 12, bottom: 12, width: 2, backgroundColor: C.accent, borderRadius: 1 },
  dow: { width: 34 },
  label: { marginTop: S.lg, marginBottom: S.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  cell: { flexBasis: '48%', flexGrow: 1 },
  cellSm: { flexBasis: '30%', flexGrow: 1 },
  nameInput: { fontFamily: F.displayBold, fontSize: 28, color: C.text, paddingVertical: S.sm, marginBottom: S.sm, borderBottomWidth: 1, borderBottomColor: C.line, textTransform: 'uppercase' },
  pva: { paddingHorizontal: S.lg, paddingVertical: S.md, gap: 6 },
  pvaHead: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  pvaNums: { flexDirection: 'row', gap: S.xl, alignItems: 'flex-end' },
  order: { width: 26, height: 26, borderRadius: R.sm, backgroundColor: C.text, alignItems: 'center', justifyContent: 'center' },
});
