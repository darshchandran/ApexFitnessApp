import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { basketballLoad } from '@/domain/load';
import type { BasketballSession, BasketballSessionType, Level } from '@/domain/types';
import { todayOverview } from '@/services/apex';
import { apex } from '@/services/useApex';
import { reduction, statusOf } from '@/ui/format';
import { ContextPrompt } from '@/ui/context';
import { goBack } from '@/ui/nav';
import { ApexCard, Button, Chip, IconButton, Segmented, StatusChip, Stepper, Txt } from '@/ui/primitives';
import { animateLayout, Expandable } from '@/ui/training';
import { bandLabel, bandTone, C, F, GUTTER, R, S } from '@/ui/theme';

const RPE_WORD = ['', 'Very easy', 'Easy', 'Light', 'Moderate', 'Steady', 'Hard', 'Hard', 'Very hard', 'Near max', 'Max'];
const TYPES: BasketballSessionType[] = ['skills', 'shooting', 'conditioning', 'scrimmage', 'game', 'mixed'];
const LEVELS = [0, 1, 2, 3] as const;
const LEVEL_LABEL = ['None', 'Low', 'Mod', 'High'];

function LevelPicker({ label, value, onChange }: { label: string; value?: Level; onChange: (l: Level) => void }) {
  return (
    <View style={{ marginTop: S.lg }}>
      <Txt v="overline" style={{ marginBottom: S.sm }}>{label}</Txt>
      <Segmented label={label} options={LEVELS} value={value} onChange={onChange} format={(l) => LEVEL_LABEL[l]} />
    </View>
  );
}

export default function Practice() {
  const insets = useSafeAreaInsets();
  const [minutes, setMinutes] = useState(75);
  const [rpe, setRpe] = useState<number | undefined>(undefined);
  const [type, setType] = useState<BasketballSessionType | undefined>();
  const [d, setD] = useState<Partial<Pick<BasketballSession, 'running' | 'sprinting' | 'jumping' | 'changeOfDirection' | 'lowerFatigue' | 'upperFatigue'>>>({});
  const [notes, setNotes] = useState('');
  const [saved, setSaved] = useState<BasketballSession | null>(null);

  const save = () => {
    if (!rpe) return;
    animateLayout();
    setSaved(apex.logBasketball({ durationMin: minutes, rpe, sessionType: type, ...d, notes: notes.trim() || undefined }) ?? null);
  };

  if (saved) {
    const o = todayOverview(apex.getState().data, apex.today());
    const l = basketballLoad(saved);
    const sessions = [o.gym, o.plyo].filter((i) => i && i.status === 'planned');
    return (
      <View style={[styles.screen, { paddingTop: insets.top + S.xxl, paddingBottom: insets.bottom + S.lg }]}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER }}>
          <Txt v="overline">Practice logged</Txt>
          <Txt v="h1">{saved.durationMin} min · RPE {saved.rpe}</Txt>
          <View style={styles.resultRow}>
            <View style={{ flex: 1 }}>
              <Txt v="overline">Session load</Txt>
              <Txt v="numL">{Math.round(l.total)}</Txt>
            </View>
            <View style={{ flex: 1, gap: 6 }}>
              <Txt v="overline">Lower body</Txt>
              <StatusChip label={bandLabel[o.stress.bands.lower]} tone={bandTone[o.stress.bands.lower]} />
            </View>
            <View style={{ flex: 1, gap: 6 }}>
              <Txt v="overline">Jumps</Txt>
              <StatusChip label={bandLabel[o.stress.bands.jump]} tone={bandTone[o.stress.bands.jump]} />
            </View>
          </View>
          <Txt v="overline" style={{ marginTop: S.xxxl, marginBottom: S.md }}>Tonight</Txt>
          {sessions.length ? sessions.map((i) => (
            <ApexCard key={i!.id} style={{ marginBottom: S.md, gap: 6 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Txt v="h3">{i!.templateName}</Txt>
                <StatusChip label={statusOf(i!).label} tone={statusOf(i!).tone} />
              </View>
              {i!.decision.volumeFactor < 1 && <Txt v="label" color={C.accent}>Volume ↓ {reduction(i!.decision.volumeFactor)}%</Txt>}
              <Txt v="bodySm">{i!.decision.reasons[0]}</Txt>
            </ApexCard>
          )) : <Txt v="bodySm">No unstarted session today to adapt.</Txt>}
          <ContextPrompt situation="practice" style={{ marginTop: S.xl }} />
        </ScrollView>
        <View style={{ paddingHorizontal: GUTTER }}>
          <Button label="Done" onPress={goBack} />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={[styles.screen, { paddingTop: insets.top }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Txt v="overline">Basketball</Txt>
        <IconButton icon="close" label="Close without saving" onPress={goBack} />
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: S.xxl }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <Txt v="h1" accessibilityRole="header">Log practice</Txt>
        <Txt v="bodySm" style={{ marginTop: 4 }}>RPE and duration are enough. Apex adapts tonight’s training from them.</Txt>

        <Txt v="overline" style={styles.label}>Duration</Txt>
        <Segmented label="Duration" options={[45, 60, 75, 90, 120] as const} value={minutes as 45} onChange={setMinutes} format={(m) => `${m}`} height={52} />
        <View style={{ marginTop: S.sm }}>
          <Stepper label="Minutes" value={minutes} step={5} min={5} max={300} integer onChange={setMinutes} />
        </View>

        <View style={styles.rpeHead}>
          <Txt v="overline">Session RPE</Txt>
          <Txt v="label" color={rpe ? C.text : C.text3}>{rpe ? `${rpe} · ${RPE_WORD[rpe]}` : 'Required'}</Txt>
        </View>
        <Segmented label="RPE" options={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const} value={rpe as 1} onChange={setRpe} columns={5} height={56} />

        <Txt v="overline" style={styles.label}>Session type</Txt>
        <View style={styles.wrap}>
          {TYPES.map((t) => (
            <Chip key={t} label={t[0].toUpperCase() + t.slice(1)} selected={type === t} onPress={() => setType(type === t ? undefined : t)} style={{ flexBasis: '31%', flexGrow: 1 }} />
          ))}
        </View>

        <View style={{ marginTop: S.xl }}>
          <Expandable title="Movement & fatigue (optional)">
            <LevelPicker label="Running" value={d.running} onChange={(l) => setD({ ...d, running: l })} />
            <LevelPicker label="Sprinting" value={d.sprinting} onChange={(l) => setD({ ...d, sprinting: l })} />
            <LevelPicker label="Jumping" value={d.jumping} onChange={(l) => setD({ ...d, jumping: l })} />
            <LevelPicker label="Change of direction" value={d.changeOfDirection} onChange={(l) => setD({ ...d, changeOfDirection: l })} />
            <LevelPicker label="Lower-body fatigue" value={d.lowerFatigue} onChange={(l) => setD({ ...d, lowerFatigue: l })} />
            <LevelPicker label="Upper-body fatigue" value={d.upperFatigue} onChange={(l) => setD({ ...d, upperFatigue: l })} />
            <Txt v="overline" style={styles.label}>Notes</Txt>
            <TextInput value={notes} onChangeText={setNotes} multiline maxLength={500} placeholder="Scrimmage heavy, knees felt fine…" placeholderTextColor={C.text3} style={styles.notes} accessibilityLabel="Practice notes" />
          </Expandable>
        </View>
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: insets.bottom + S.md }]}>
        <Button label={rpe ? 'Save practice' : 'Select RPE to save'} icon="check" disabled={!rpe} onPress={save} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: GUTTER, paddingRight: S.sm, height: 56 },
  label: { marginTop: S.xxl, marginBottom: S.sm },
  rpeHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: S.xxl, marginBottom: S.sm },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  notes: { minHeight: 88, borderRadius: R.md, backgroundColor: C.raised, color: C.text, padding: S.md, fontFamily: F.regular, fontSize: 15, textAlignVertical: 'top' },
  footer: { paddingHorizontal: GUTTER, paddingTop: S.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line, backgroundColor: C.bg },
  resultRow: { flexDirection: 'row', gap: S.md, marginTop: S.xxl, alignItems: 'flex-end' },
});
