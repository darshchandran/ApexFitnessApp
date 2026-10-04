// One day of the athlete's week: the program's sessions plus their recurring activities.
// Program and Profile share this editor. Gym and plyo slots stay the program's; schedule items
// add timing and other activities. Nothing here counts as training — only logged sessions do.
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, TextInput, View } from 'react-native';

import { weeklySchedule, type DayEntry, type Intensity, type ScheduleItem, type ScheduleKind } from '@/domain/profile';
import { timeLabel, WEEKDAYS } from '@/domain/schedule';
import type { ApexData, PlanDay, SlotRef } from '@/domain/types';
import { apex, useApex } from '@/services/useApex';
import { BottomSheet } from './BottomSheet';
import { Icon, type IconName } from './Icon';
import { Chip, Divider, IconButton, Txt } from './primitives';
import { C, F, R, S } from './theme';

export const KIND_LABEL: Record<ScheduleKind, string> = { basketball: 'Basketball', gym: 'Gym', plyo: 'Plyos', conditioning: 'Conditioning', other: 'Other' };
const KIND_ICON: Record<ScheduleKind, IconName> = { basketball: 'ball', gym: 'train', plyo: 'bolt', conditioning: 'timer', other: 'plus' };
const TIMES: { value: string | undefined; label: string }[] = [
  { value: undefined, label: 'Any' }, { value: 'morning', label: 'Morning' }, { value: 'midday', label: 'Midday' }, { value: 'afternoon', label: 'Afternoon' },
  { value: 'evening', label: 'Evening' }, { value: '06:00', label: '06:00' }, { value: '07:00', label: '07:00' }, { value: '18:00', label: '18:00' }, { value: '19:00', label: '19:00' },
];
const DURATIONS = [undefined, 45, 60, 90, 120];
const INTENSITIES: (Intensity | undefined)[] = [undefined, 'light', 'moderate', 'hard'];
const slotKey = (s?: SlotRef) => (!s ? 'none' : 'templateId' in s ? `t:${s.templateId}` : `r:${s.rotationId}`);

const programName = (d: ApexData, e: Pick<DayEntry, 'templateId' | 'rotationId'>) =>
  e.templateId ? [...d.templates, ...d.plyoTemplates].find((t) => t.id === e.templateId)?.name
    : e.rotationId ? `${d.plan.rotations.find((r) => r.id === e.rotationId)?.name ?? 'Rotation'} rotation` : undefined;

/** "Basketball · Practice 07:00", "Push rotation evening", "Conditioning" — for one entry. */
export function entryText(d: ApexData, e: DayEntry) {
  const name = e.source === 'program' ? programName(d, e) ?? KIND_LABEL[e.kind] : e.label ? `${KIND_LABEL[e.kind]} · ${e.label}` : KIND_LABEL[e.kind];
  const t = timeLabel(e.time === 'varies' ? undefined : e.time);
  return `${name}${t ? ` ${t.toLowerCase().includes(':') ? t : t.toLowerCase()}` : ''}`;
}

/** The enabled activities on a day, as short text. Empty = rest. */
export const dayActivities = (d: ApexData, i: number) => weeklySchedule(d)[i].filter((e) => e.enabled).map((e) => entryText(d, e));

function ItemRow({ item, first, last }: { item: ScheduleItem; first: boolean; last: boolean }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(item.label ?? '');
  const set = (patch: Partial<ScheduleItem>) => apex.updateScheduleItem(item.id, patch);
  const summary = [timeLabel(item.time === 'varies' ? undefined : item.time) || 'Any time', item.durationMin && `${item.durationMin} min`, item.intensity && item.intensity[0].toUpperCase() + item.intensity.slice(1)].filter(Boolean).join(' · ');
  return (
    <View style={[styles.item, !item.enabled && { opacity: 0.55 }]}>
      <View style={styles.itemHead}>
        <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }}
          accessibilityLabel={`${KIND_LABEL[item.kind]}${item.label ? `, ${item.label}` : ''}: ${summary}${item.enabled ? '' : ', off'}. Edit`} style={styles.itemMain}>
          <Icon name={KIND_ICON[item.kind]} size={18} color={C.text2} />
          <View style={{ flex: 1, gap: 2 }}>
            <Txt v="title" numberOfLines={1}>{KIND_LABEL[item.kind]}{item.label ? ` · ${item.label}` : ''}</Txt>
            <Txt v="bodySm" numberOfLines={1}>{summary}{item.enabled ? '' : ' · off'}</Txt>
          </View>
        </Pressable>
        <Switch value={item.enabled} onValueChange={(enabled) => set({ enabled })} trackColor={{ true: C.accent, false: C.lineStrong }} thumbColor={C.text}
          {...({ activeThumbColor: C.text } as object)} accessibilityLabel={`${KIND_LABEL[item.kind]} on this day`} />
      </View>
      {open && (
        <View style={styles.itemEdit}>
          <TextInput value={label} onChangeText={(t) => { setLabel(t); set({ label: t.trim() || undefined }); }}
            placeholder="Label · optional — e.g. Practice" placeholderTextColor={C.text3} maxLength={30} returnKeyType="done" style={styles.input} accessibilityLabel="Label" />
          <Txt v="overline">Time · optional</Txt>
          <View style={styles.grid}>
            {TIMES.map((t) => <Chip key={t.label} label={t.label} selected={item.time === t.value} onPress={() => set({ time: t.value })} style={styles.cellSm} />)}
          </View>
          <Txt v="overline">Duration · optional</Txt>
          <View style={styles.grid}>
            {DURATIONS.map((m) => <Chip key={m ?? 'none'} label={m ? `${m} min` : '—'} selected={item.durationMin === m} onPress={() => set({ durationMin: m })} style={styles.cellXs} />)}
          </View>
          <Txt v="overline">Intensity · optional</Txt>
          <View style={styles.grid}>
            {INTENSITIES.map((x) => <Chip key={x ?? 'none'} label={x ? x[0].toUpperCase() + x.slice(1) : '—'} selected={item.intensity === x} onPress={() => set({ intensity: x })} style={styles.cellXs} />)}
          </View>
          <View style={[styles.grid, { alignItems: 'center' }]}>
            <IconButton icon="arrow-up" label="Earlier in the day" filled onPress={() => apex.moveScheduleItem(item.id, -1)} style={first ? { opacity: 0.35 } : undefined} />
            <IconButton icon="arrow-down" label="Later in the day" filled onPress={() => apex.moveScheduleItem(item.id, 1)} style={last ? { opacity: 0.35 } : undefined} />
            <Pressable onPress={() => apex.removeScheduleItem(item.id)} accessibilityRole="button" hitSlop={6} style={styles.remove}>
              <Icon name="trash" size={16} color={C.danger} />
              <Txt v="label" color={C.danger}>Remove</Txt>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

export function DayEditor({ index, onClose }: { index: number; onClose: () => void }) {
  const { data } = useApex();
  const day = data.plan.days[index];
  const set = (patch: Partial<PlanDay>) => apex.setPlanDay(index, { ...day, ...patch });
  const items = (data.profile.schedule ?? []).filter((i) => i.day === index);
  const gymOptions: { key: string; label: string; slot?: SlotRef }[] = [
    { key: 'none', label: 'None' },
    ...data.plan.rotations.map((r) => ({ key: `r:${r.id}`, label: `${r.name} rot.`, slot: { rotationId: r.id } })),
    ...data.templates.map((t) => ({ key: `t:${t.id}`, label: t.name, slot: { templateId: t.id } })),
  ];
  const plyoOptions = [{ key: 'none', label: 'None', slot: undefined as SlotRef | undefined }, ...data.plyoTemplates.map((t) => ({ key: `t:${t.id}`, label: t.name, slot: { templateId: t.id } as SlotRef }))];
  const rest = !day.gym && !day.plyo && !items.some((i) => i.enabled);
  const add = (kind: ScheduleKind) => apex.addScheduleItem({ day: index, kind });
  return (
    <BottomSheet visible onClose={onClose} title={`${WEEKDAYS[index]} · edit day`}>
      <Txt v="bodySm">{rest ? 'Rest day.' : 'A day can hold several activities.'} Planned days never count as training — only what you log does.</Txt>

      <Txt v="overline" style={styles.label}>Program · gym</Txt>
      <View style={styles.grid}>
        {gymOptions.map((o) => <Chip key={o.key} label={o.label} selected={slotKey(day.gym) === o.key} onPress={() => set({ gym: o.slot })} style={styles.cell} />)}
      </View>
      <Txt v="overline" style={styles.label}>Program · plyometrics</Txt>
      <View style={styles.grid}>
        {plyoOptions.map((o) => <Chip key={o.key} label={o.label} selected={slotKey(day.plyo) === o.key} onPress={() => set({ plyo: o.slot })} style={styles.cell} />)}
      </View>

      <Txt v="overline" style={styles.label}>Activities & times</Txt>
      {items.length === 0 && <Txt v="bodySm" color={C.text3}>None yet. Add practice, conditioning, or a time for this day’s gym session.</Txt>}
      {items.map((it, k) => (
        <View key={it.id}>
          {k > 0 && <Divider />}
          <ItemRow item={it} first={k === 0} last={k === items.length - 1} />
        </View>
      ))}
      <View style={[styles.grid, { marginTop: S.md }]}>
        {(['basketball', 'gym', 'conditioning', 'other'] as const).map((k) => (
          <Chip key={k} label={`+ ${k === 'gym' ? 'Gym time' : KIND_LABEL[k]}`} selected={false} onPress={() => add(k)} style={styles.cell} />
        ))}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  label: { marginTop: S.lg, marginBottom: S.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  cell: { flexBasis: '48%', flexGrow: 1 },
  cellSm: { flexBasis: '30%', flexGrow: 1 },
  cellXs: { flexBasis: '18%', flexGrow: 1, paddingHorizontal: 2 },
  item: { paddingVertical: S.sm },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  itemMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 48 },
  itemEdit: { gap: S.sm, paddingTop: S.sm, paddingLeft: 30 },
  input: { height: 44, borderRadius: R.sm, backgroundColor: C.raised, color: C.text, paddingHorizontal: S.md, fontFamily: F.regular, fontSize: 15 },
  remove: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: S.md, marginLeft: 'auto' },
});
