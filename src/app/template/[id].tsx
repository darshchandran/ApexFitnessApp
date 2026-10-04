import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PRIORITY_LABEL, priorityOf } from '@/domain/areas';
import { GYM_EXERCISES, MUSCLE_LABEL, PLYO_EXERCISES, gymExercise } from '@/domain/catalog';
import { templateContacts } from '@/domain/load';
import * as T from '@/domain/templates';
import type { PlyometricTemplate, Template, WorkoutTemplate } from '@/domain/types';
import { apex, useApex } from '@/services/useApex';
import { BottomSheet } from '@/ui/BottomSheet';
import { pad2, repRange, restLabel } from '@/ui/format';
import { Icon } from '@/ui/Icon';
import { Button, Chip, Divider, EmptyState, IconButton, ListRow, Segmented, StatusChip, Stepper, Txt } from '@/ui/primitives';
import { go, goBack } from '@/ui/nav';
import { animateLayout } from '@/ui/training';
import { C, F, GUTTER, R, S, TOUCH } from '@/ui/theme';

const RESTS = [45, 60, 90, 120, 150, 180];

export default function TemplateEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data } = useApex();
  const insets = useSafeAreaInsets();
  const t: Template | undefined = data.templates.find((x) => x.id === id) ?? data.plyoTemplates.find((x) => x.id === id);
  const [open, setOpen] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(t?.name ?? '');
  const [tag, setTag] = useState(t?.tag ?? '');

  if (!t) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + S.huge, paddingHorizontal: GUTTER }]}>
        <EmptyState title="Template not found" message="It may have been deleted. Sessions already logged from it are kept." action="Back" onAction={goBack} />
      </View>
    );
  }
  const now = () => new Date().toISOString();
  const save = (next: Template) => apex.saveTemplate(next);
  const rename = (n: string) => {
    setName(n);
    if (n.trim() && n.trim() !== t.name) save({ ...t, name: n.trim(), updatedAt: now() });
  };
  const retag = (g: string) => {
    setTag(g);
    if (g.trim() && g.trim().toUpperCase() !== t.tag) save({ ...t, tag: g.trim().toUpperCase(), updatedAt: now() });
  };
  const volume = t.kind === 'gym' ? { n: T.workingSetCount(t), label: 'working sets' } : { n: templateContacts(t), label: 'contacts' };
  const today = apex.today();
  const running = data.instances.find((i) => i.date === today && i.templateId === t.id && i.status === 'active');
  // today's session from this template (never a duplicate); its overview's LOG ALL starts it
  const openToday = () => {
    const id = running?.id ?? apex.openTemplate(t.kind, t.id);
    if (id) go.workout(id);
  };

  return (
    <KeyboardAvoidingView style={[styles.screen, { paddingTop: insets.top }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <IconButton icon="chevron-left" label="Back" onPress={goBack} />
        <Txt v="overline">{t.kind === 'gym' ? 'Gym template' : 'Plyometric template'}</Txt>
        <IconButton icon="more" label="Template actions" onPress={() => setMenu(true)} />
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: insets.bottom + S.huge }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <TextInput value={name} onChangeText={rename} onBlur={() => setName(t.name)} maxLength={40} returnKeyType="done" style={styles.name} accessibilityLabel="Template name" />
        <View style={styles.tagRow}>
          <View style={styles.tagMark} />
          <TextInput value={tag} onChangeText={retag} onBlur={() => setTag(t.tag)} maxLength={24} returnKeyType="done" autoCapitalize="characters" style={styles.tag} accessibilityLabel="Template tag" />
        </View>
        <Text style={styles.stats}>
          <Text style={styles.statNum}>{pad2(t.exercises.length)}</Text> EXERCISES   <Text style={styles.statNum}>{pad2(volume.n)}</Text> {volume.label.toUpperCase()}
        </Text>

        <View style={{ marginTop: S.xl, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line }}>
          {t.exercises.length === 0 && <View style={{ paddingVertical: S.xl }}><EmptyState title="No exercises" message="Build the session you want to run. Apex will adapt it, never rewrite it." /></View>}
          {t.kind === 'gym'
            ? t.exercises.map((e, i) => (
              <GymRow key={e.id} t={t} i={i} open={open === e.id} onToggle={() => { animateLayout(); setOpen(open === e.id ? null : e.id); }} save={save} />
            ))
            : t.exercises.map((e, i) => (
              <PlyoRow key={e.id} t={t} i={i} open={open === e.id} onToggle={() => { animateLayout(); setOpen(open === e.id ? null : e.id); }} save={save} />
            ))}
        </View>
        <Button label="Add exercise" variant="secondary" icon="plus" onPress={() => setPicker(true)} style={{ marginTop: S.xl }} />
      </ScrollView>
      {t.exercises.length > 0 && (
        <View style={[styles.footer, { paddingBottom: insets.bottom + S.md }]}>
          <Button label={running ? 'Resume workout' : 'Start workout'} icon="play" onPress={openToday}
            accessibilityLabel={running ? `Resume ${t.name}` : `Start today’s ${t.name}: see the prescription, then log all`} />
          {!running && <Txt v="bodySm" style={{ textAlign: 'center', marginTop: 6 }}>Today’s {t.name}, adapted to your load. Review it, then LOG ALL.</Txt>}
        </View>
      )}

      {picker && <ExercisePicker kind={t.kind} onClose={() => setPicker(false)} onPick={(exId) => {
        const next = t.kind === 'gym' ? T.addGymExercise(t, exId, now()) : T.addPlyoExercise(t, exId, now());
        save(next);
        setPicker(false);
        setOpen(next.exercises[next.exercises.length - 1].id);
      }} />}

      <BottomSheet visible={menu} onClose={() => setMenu(false)} title={t.name}>
        <ListRow title="Duplicate" subtitle="Make an editable copy — e.g. a V2" left={<Icon name="copy" color={C.text2} />} onPress={() => {
          const copy = apex.duplicateTemplate(t.id);
          setMenu(false);
          if (copy) router.replace({ pathname: '/template/[id]', params: { id: copy } });
        }} />
        <Divider />
        <ListRow title="Delete" subtitle="Removes it from the schedule and rotations. History is kept." left={<Icon name="trash" color={C.danger} />} onPress={() => { setMenu(false); setConfirmDelete(true); }} />
      </BottomSheet>

      <BottomSheet visible={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete ${t.name}?`}
        footer={<Button label="Delete template" variant="danger" icon="trash" onPress={() => { setConfirmDelete(false); goBack(); apex.deleteTemplate(t.id); }} />}>
        <Txt v="body" color={C.text2}>Completed sessions stay in your history. Days that used this template become empty.</Txt>
      </BottomSheet>
    </KeyboardAvoidingView>
  );
}

function RowShell({ i, title, summary, open, onToggle, superset, children }: { i: number; title: string; summary: string; open: boolean; onToggle: () => void; superset?: boolean; children: ReactNode }) {
  return (
    <View style={styles.rowWrap}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${title}, ${summary}`} style={styles.row}>
        <Text style={styles.idx}>{pad2(i + 1)}</Text>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="title" numberOfLines={2}>{title}</Txt>
          <Txt v="bodySm">{summary}</Txt>
        </View>
        {superset && <StatusChip label="Superset" tone="accent" />}
        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Icon name="chevron-down" size={18} color={C.text2} /></View>
      </Pressable>
      {open && <View style={styles.editor}>{children}</View>}
    </View>
  );
}

function OrderActions({ t, id, save }: { t: Template; id: string; save: (t: Template) => void }) {
  const now = new Date().toISOString();
  return (
    <View style={{ flexDirection: 'row', gap: S.sm }}>
      <IconButton icon="arrow-up" label="Move up" filled onPress={() => { animateLayout(); save(T.moveExercise(t, id, -1, now)); }} />
      <IconButton icon="arrow-down" label="Move down" filled onPress={() => { animateLayout(); save(T.moveExercise(t, id, 1, now)); }} />
      <Button label="Remove" variant="danger" size="md" icon="trash" onPress={() => { animateLayout(); save(T.removeExercise(t, id, now)); }} style={{ flex: 1 }} />
    </View>
  );
}

function GymRow({ t, i, open, onToggle, save }: { t: WorkoutTemplate; i: number; open: boolean; onToggle: () => void; save: (t: Template) => void }) {
  const e = t.exercises[i];
  const now = new Date().toISOString();
  const upd = (patch: Partial<WorkoutTemplate['exercises'][number]>) => save(T.updateExercise(t, e.id, patch, now));
  const [notes, setNotes] = useState(e.notes ?? '');
  const priority = priorityOf(e, gymExercise(e.exerciseId));
  return (
    <RowShell i={i} title={e.name} summary={`${e.sets} × ${repRange(e.repRange)} · ${e.targetRir} RIR · rest ${restLabel(e.restSec)}${e.warmupSets ? ` · ${e.warmupSets} warm-up` : ''} · ${PRIORITY_LABEL[priority]}`} open={open} onToggle={onToggle} superset={!!e.supersetGroup}>
      <View style={styles.pair}>
        <Stepper label="Working sets" integer value={e.sets} step={1} min={1} max={10} onChange={(sets) => upd({ sets })} />
        <Stepper label="Warm-up" integer value={e.warmupSets} step={1} min={0} max={5} onChange={(warmupSets) => upd({ warmupSets })} />
      </View>
      <View style={styles.pair}>
        <Stepper label="Reps min" integer value={e.repRange[0]} step={1} min={1} max={e.repRange[1]} onChange={(lo) => upd({ repRange: [lo, e.repRange[1]] })} />
        <Stepper label="Reps max" integer value={e.repRange[1]} step={1} min={e.repRange[0]} max={50} onChange={(hi) => upd({ repRange: [e.repRange[0], hi] })} />
      </View>
      <View>
        <Txt v="overline" style={styles.label}>Target RIR</Txt>
        <Segmented label="Target RIR" options={[0, 1, 2, 3, 4] as const} value={e.targetRir as 0} onChange={(targetRir) => upd({ targetRir })} />
      </View>
      <View>
        <Txt v="overline" style={styles.label}>Rest</Txt>
        <View style={styles.grid}>
          {RESTS.map((r) => <Chip key={r} label={restLabel(r)} selected={e.restSec === r} onPress={() => upd({ restSec: r })} style={{ flexBasis: '30%', flexGrow: 1 }} />)}
        </View>
      </View>
      <View>
        <Txt v="overline" style={styles.label}>Priority when Apex trims a session</Txt>
        <View style={styles.grid}>
          {(['primary', 'secondary', 'accessory', 'optional'] as const).map((p) => (
            <Chip key={p} label={PRIORITY_LABEL[p]} selected={priority === p} onPress={() => upd({ priority: p })} style={{ flexBasis: '48%', flexGrow: 1 }} />
          ))}
        </View>
        <Txt v="bodySm" style={{ marginTop: S.sm }}>Primary lifts are protected; optional work is the first to go on a high-load day.</Txt>
      </View>
      <TextInput value={notes} onChangeText={(n) => { setNotes(n); upd({ notes: n.trim() || undefined }); }} maxLength={300} placeholder="Notes — setup, cues" placeholderTextColor={C.text3} style={styles.notes} multiline accessibilityLabel="Exercise notes" />
      <Button label={e.supersetGroup ? 'Unlink superset' : i < t.exercises.length - 1 ? 'Superset with next' : 'Superset (needs a next exercise)'} variant="secondary" size="md" icon="link"
        disabled={!e.supersetGroup && i >= t.exercises.length - 1} onPress={() => save(T.toggleSuperset(t, e.id, now))} />
      <OrderActions t={t} id={e.id} save={save} />
    </RowShell>
  );
}

function PlyoRow({ t, i, open, onToggle, save }: { t: PlyometricTemplate; i: number; open: boolean; onToggle: () => void; save: (t: Template) => void }) {
  const e = t.exercises[i];
  const now = new Date().toISOString();
  const upd = (patch: Partial<PlyometricTemplate['exercises'][number]>) => save(T.updateExercise(t, e.id, patch, now));
  return (
    <RowShell i={i} title={e.name} summary={`${e.sets} × ${e.reps}${e.perSide ? '/side' : ''} · ${e.sets * e.reps * (e.perSide ? 2 : 1)} contacts · rest ${restLabel(e.restSec)}`} open={open} onToggle={onToggle}>
      <View style={styles.pair}>
        <Stepper label="Sets" integer value={e.sets} step={1} min={1} max={10} onChange={(sets) => upd({ sets })} />
        <Stepper label={e.perSide ? 'Reps / side' : 'Reps'} integer value={e.reps} step={1} min={1} max={50} onChange={(reps) => upd({ reps })} />
      </View>
      <View>
        <Txt v="overline" style={styles.label}>Sides</Txt>
        <Segmented label="Sides" options={['both', 'each'] as const} value={e.perSide ? 'each' : 'both'} onChange={(v) => upd({ perSide: v === 'each' })} format={(v) => (v === 'each' ? 'PER SIDE' : 'BILATERAL')} />
      </View>
      <View>
        <Txt v="overline" style={styles.label}>Rest</Txt>
        <View style={styles.grid}>
          {RESTS.map((r) => <Chip key={r} label={restLabel(r)} selected={e.restSec === r} onPress={() => upd({ restSec: r })} style={{ flexBasis: '30%', flexGrow: 1 }} />)}
        </View>
      </View>
      <OrderActions t={t} id={e.id} save={save} />
    </RowShell>
  );
}

function ExercisePicker({ kind, onClose, onPick }: { kind: Template['kind']; onClose: () => void; onPick: (id: string) => void }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const all = kind === 'gym'
      ? GYM_EXERCISES.map((e) => ({ id: e.id, name: e.name, sub: `${MUSCLE_LABEL[e.primary]} · ${e.region}` }))
      : PLYO_EXERCISES.map((e) => ({ id: e.id, name: e.name, sub: e.categories.join(' · ') }));
    return s ? all.filter((e) => e.name.toLowerCase().includes(s) || e.sub.toLowerCase().includes(s)) : all;
  }, [q, kind]);
  return (
    <BottomSheet visible onClose={onClose} title="Add exercise">
      <View style={styles.search}>
        <Icon name="search" size={18} color={C.text3} />
        <TextInput value={q} onChangeText={setQ} placeholder="Search exercise or muscle" placeholderTextColor={C.text3} style={styles.searchInput} autoFocus accessibilityLabel="Search exercises" />
      </View>
      {list.map((e, i) => (
        <View key={e.id}>
          {i > 0 && <Divider />}
          <ListRow title={e.name} subtitle={e.sub} onPress={() => onPick(e.id)} />
        </View>
      ))}
      {!list.length && <Txt v="bodySm" style={{ paddingVertical: S.lg }}>Nothing matches “{q}”.</Txt>}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  footer: { paddingHorizontal: GUTTER, paddingTop: S.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.lineStrong, backgroundColor: C.surface },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: S.sm, height: 56 },
  name: { fontFamily: F.displayBold, fontSize: 40, color: C.text, textTransform: 'uppercase', paddingVertical: 0, marginTop: S.sm },
  tagRow: { flexDirection: 'row', alignItems: 'center', marginTop: S.xs },
  tagMark: { width: 3, height: 12, backgroundColor: C.accent, marginRight: S.sm, borderRadius: 1 },
  tag: { flex: 1, fontFamily: F.semibold, fontSize: 12, letterSpacing: 1.6, color: C.text, paddingVertical: 6 },
  stats: { fontFamily: F.semibold, fontSize: 11, letterSpacing: 1.4, color: C.text3, marginTop: S.md },
  statNum: { fontFamily: F.display, fontSize: 22, color: C.text, letterSpacing: 0 },
  rowWrap: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingVertical: S.md, minHeight: 64 },
  idx: { fontFamily: F.display, fontSize: 18, color: C.text2, width: 26, fontVariant: ['tabular-nums'] },
  editor: { gap: S.lg, paddingBottom: S.xl, paddingLeft: 38 },
  pair: { flexDirection: 'row', gap: S.md },
  label: { marginBottom: S.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  notes: { minHeight: 56, borderRadius: R.md, backgroundColor: C.raised, color: C.text, padding: S.md, fontFamily: F.regular, fontSize: 15 },
  search: { flexDirection: 'row', alignItems: 'center', gap: S.sm, backgroundColor: C.raised, borderRadius: R.md, paddingHorizontal: S.md, height: TOUCH, marginBottom: S.sm },
  searchInput: { flex: 1, color: C.text, fontFamily: F.regular, fontSize: 15, height: TOUCH },
});
