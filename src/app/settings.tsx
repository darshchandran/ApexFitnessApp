import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { APEX_CONFIG } from '@/domain/config';
import { fromUnits, profileFacts, toUnits, type Experience, type TrainingTime } from '@/domain/profile';
import { rotationCount, WEEKDAYS } from '@/domain/schedule';
import { apex, useApex } from '@/services/useApex';
import { BottomSheet } from '@/ui/BottomSheet';
import { AFTER, FOCUS, GOALS, SLOTS, SPORTS, slotLabel } from '@/ui/context';
import { Icon } from '@/ui/Icon';
import { goBack } from '@/ui/nav';
import { ApexCard, Button, Divider, IconButton, Segmented, Txt } from '@/ui/primitives';
import { DayEditor, dayActivities } from '@/ui/schedule';
import { Expandable } from '@/ui/training';
import { useUnits, wtu } from '@/ui/units';
import { C, F, GUTTER, R, S } from '@/ui/theme';

const EXPERIENCE: { value: Experience; label: string }[] = [
  { value: 'new', label: 'Under 1 yr' }, { value: 'intermediate', label: '1–3 yrs' }, { value: 'advanced', label: '3+ yrs' },
];

/** A labelled choice row. Nothing selected = not set yet — never shown as an error. */
function Field<T extends string>({ label, hint, options, value, onChange, wrap }: {
  label: string; hint?: string; options: { value: T; label: string }[]; value: T | undefined; onChange: (v: T) => void; wrap?: boolean;
}) {
  return (
    <View style={styles.field}>
      <View style={styles.fieldHead}>
        <Txt v="overline">{label}</Txt>
        {value === undefined && <Txt v="label" color={C.text3}>Not set</Txt>}
      </View>
      <Segmented label={label} options={options.map((o) => o.value)} value={value} onChange={onChange} columns={wrap ? 3 : undefined}
        format={(v) => options.find((o) => o.value === v)!.label.toUpperCase()} height={44} />
      {hint ? <Txt v="bodySm" style={{ marginTop: 6 }}>{hint}</Txt> : null}
    </View>
  );
}

/** An optional number: blank = not set. Saved when it's a sensible value. */
function NumberField({ label, unit, value, min, max, onSave }: { label: string; unit: string; value?: number; min: number; max: number; onSave: (v: number | undefined) => void }) {
  const [text, setText] = useState(value === undefined ? '' : String(+value.toFixed(1)));
  // saved as soon as it is a sensible value (or cleared); a half-typed number waits
  const save = (t: string) => {
    const v = Number(t.replace(',', '.'));
    if (t.trim() === '') onSave(undefined);
    else if (Number.isFinite(v) && v >= min && v <= max) onSave(v);
    else return false;
    return true;
  };
  const commit = () => { if (!save(text)) setText(value === undefined ? '' : String(+value.toFixed(1))); };
  return (
    <View style={styles.numRow}>
      <Txt v="body" style={{ flex: 1 }}>{label}</Txt>
      <TextInput value={text} onChangeText={(t) => { const clean = t.replace(/[^0-9.,]/g, ''); setText(clean); save(clean); }} onBlur={commit} onSubmitEditing={commit} keyboardType="decimal-pad" returnKeyType="done"
        placeholder="—" placeholderTextColor={C.text3} maxLength={6} style={styles.numInput} accessibilityLabel={`${label} in ${unit}`} />
      <Txt v="label" style={{ width: 28 }}>{unit}</Txt>
    </View>
  );
}

/** The athlete's profile: everything Apex learned, all editable — no onboarding to repeat. */
export default function Profile() {
  const { data } = useApex();
  const insets = useSafeAreaInsets();
  const u = useUnits();
  const p = data.profile;
  const facts = profileFacts(data);
  const [name, setName] = useState(data.user.name);
  const [confirm, setConfirm] = useState(false);
  const [day, setDay] = useState<number | null>(null);
  const [m, h, e] = APEX_CONFIG.dailyBands;
  const bodyweight = data.bodyMetrics.filter((x) => x.kind === 'bodyweight').sort((a, b) => a.date.localeCompare(b.date)).pop();
  const basketball = p.sport === 'basketball' || (p.schedule ?? []).some((i) => i.kind === 'basketball') || data.basketball.length > 0;
  const rotation = data.plan.rotations[0];
  const nextInRotation = rotation?.templateIds.length ? data.templates.find((t) => t.id === rotation.templateIds[rotationCount(data.instances, rotation.id) % rotation.templateIds.length])?.name : undefined;
  const gymTimeValue = p.gymTime && !p.gymTime.includes(':') ? (p.gymTime as TrainingTime) : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top }}>
      <View style={styles.header}>
        <IconButton icon="chevron-left" label="Back" onPress={() => goBack()} />
        <Txt v="overline">Profile</Txt>
        <View style={{ width: 48 }} />
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: insets.bottom + S.huge }} keyboardShouldPersistTaps="handled">
        <TextInput value={name} onChangeText={(t) => { setName(t); if (t.trim()) apex.updateUser({ name: t.trim() }); }} maxLength={40} returnKeyType="done"
          style={styles.name} accessibilityLabel="Name" />
        <Txt v="bodySm">Apex fills this in as you train. Everything here is optional and stays on this device.</Txt>

        <Txt v="overline" style={styles.section}>Athlete</Txt>
        <Field label="Goal" options={GOALS} value={p.goal} onChange={(goal) => apex.updateProfile({ goal })}
          hint={p.goal ? GOALS.find((g) => g.value === p.goal)!.sub : 'Tell Apex what you’re training for.'} />
        <Field label="Main sport" options={SPORTS} value={p.sport} onChange={(sport) => apex.updateProfile({ sport })} />
        <Field label="Training age" options={EXPERIENCE} value={p.experience} onChange={(experience) => apex.updateProfile({ experience })} />
        <Field label="Improving right now" options={FOCUS} value={p.focus} onChange={(focus) => apex.updateProfile({ focus })} wrap />

        <Txt v="overline" style={styles.section}>Training</Txt>
        <Pressable onPress={() => router.navigate('/program')} accessibilityRole="button" style={({ pressed }) => [styles.program, pressed && { backgroundColor: C.pressed }]}>
          <View style={{ flex: 1, gap: 2 }}>
            <Txt v="overline">Program</Txt>
            <Txt v="title">{data.plan.name}</Txt>
            {nextInRotation && <Txt v="bodySm">{rotation.name} rotation · next {nextInRotation}</Txt>}
          </View>
          <Icon name="chevron-right" size={18} color={C.text3} />
        </Pressable>
        <Txt v="overline" style={{ marginTop: S.lg, marginBottom: S.sm }}>Weekly schedule</Txt>
        <ApexCard padded={false}>
          {WEEKDAYS.map((w, i) => {
            const acts = dayActivities(data, i);
            return (
              <View key={w}>
                {i > 0 && <Divider />}
                <Pressable onPress={() => setDay(i)} accessibilityRole="button" accessibilityLabel={`${w}: ${acts.join(', ') || 'rest'}. Edit`}
                  style={({ pressed }) => [styles.dayRow, pressed && { backgroundColor: C.pressed }]}>
                  <Txt v="overline" style={{ width: 36 }} color={acts.length ? C.text : C.text3}>{w}</Txt>
                  <Txt v="body" style={{ flex: 1 }} color={acts.length ? C.text : C.text3} numberOfLines={2}>{acts.join(' · ') || 'Rest'}</Txt>
                  <Icon name="chevron-right" size={18} color={C.text3} />
                </Pressable>
              </View>
            );
          })}
        </ApexCard>
        <Txt v="bodySm" style={{ marginTop: S.sm }}>
          {facts.basketballDays || !basketball ? 'Your usual week. Planned days never count as training — only sessions you log do.' : 'Add your usual basketball days to make your week accurate. Only practices you log count as load.'}
        </Txt>
        <Field label="Usual gym time" options={SLOTS} value={gymTimeValue} onChange={(gymTime) => apex.updateProfile({ gymTime })} wrap
          hint={p.gymTime?.includes(':') ? slotLabel(p.gymTime) : 'A day’s own time in the schedule wins.'} />

        {basketball && (
          <>
            <Txt v="overline" style={styles.section}>Basketball</Txt>
            <ApexCard padded={false}>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Txt v="title">Adjust gym for basketball</Txt>
                  <Txt v="bodySm">Logged practices shape today’s gym session. Off: they still count in your training load, just not in adaptation.</Txt>
                </View>
                <Switch value={p.useBasketballLoad !== false} onValueChange={(useBasketballLoad) => apex.updateProfile({ useBasketballLoad })}
                  trackColor={{ true: C.accent, false: C.lineStrong }} thumbColor={C.text} {...({ activeThumbColor: C.text } as object)} accessibilityLabel="Adjust gym sessions for basketball" />
              </View>
            </ApexCard>
            <Field label="Gym after basketball" options={AFTER} value={p.gymAfterBasketball} onChange={(gymAfterBasketball) => apex.updateProfile({ gymAfterBasketball })} />
          </>
        )}

        <Txt v="overline" style={styles.section}>Tracking</Txt>
        <Field label="Units" options={[{ value: 'kg' as const, label: 'kg' }, { value: 'lb' as const, label: 'lb' }]} value={p.units} onChange={(units) => apex.updateProfile({ units })}
          hint={p.units ? undefined : 'Showing kg until you choose.'} />
        <ApexCard padded={false} style={{ marginTop: S.lg }}>
          <Pressable onPress={() => router.navigate('/progress')} accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && { backgroundColor: C.pressed }]}>
            <View style={{ flex: 1 }}>
              <Txt v="title">Bodyweight</Txt>
              <Txt v="bodySm">{bodyweight ? `${wtu(bodyweight.value, u)} · logged in Progress` : 'Add bodyweight if you want bodyweight-based progress tracking.'}</Txt>
            </View>
            <Icon name="chevron-right" size={18} color={C.text3} />
          </Pressable>
          <Divider />
          <View style={{ paddingHorizontal: S.lg }}>
            <Expandable title="Body & targets">
              <View style={{ paddingBottom: S.md }}>
                <NumberField label="Height" unit="cm" value={p.heightCm} min={120} max={240} onSave={(heightCm) => apex.updateProfile({ heightCm })} />
                <NumberField label="Target bodyweight" unit={u} value={p.targetBodyweightKg === undefined ? undefined : toUnits(p.targetBodyweightKg, u)} min={30} max={u === 'lb' ? 660 : 300}
                  onSave={(v) => apex.updateProfile({ targetBodyweightKg: v === undefined ? undefined : fromUnits(v, u) })} />
                <NumberField label="Vertical jump target" unit="cm" value={p.verticalTargetCm} min={10} max={150} onSave={(verticalTargetCm) => apex.updateProfile({ verticalTargetCm })} />
                <Pressable onPress={() => router.navigate('/progress')} accessibilityRole="button" style={styles.link}>
                  <Txt v="label" color={C.text}>Measurements & jump tests in Progress ›</Txt>
                </Pressable>
              </View>
            </Expandable>
          </View>
        </ApexCard>

        <Txt v="overline" style={styles.section}>Preferences</Txt>
        <Field label="Effort scale" options={[{ value: 'rir' as const, label: 'RIR · reps in reserve' }, { value: 'rpe' as const, label: 'RPE · 6–10' }]}
          value={data.settings.effortScale} onChange={(effortScale) => apex.updateSettings({ effortScale })} />
        <ApexCard style={{ marginTop: S.lg }} padded={false}>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Txt v="title">Auto rest timer</Txt>
              <Txt v="bodySm">Starts after each working set</Txt>
            </View>
            <Switch value={data.settings.autoRest} onValueChange={(autoRest) => apex.updateSettings({ autoRest })} trackColor={{ true: C.accent, false: C.lineStrong }} thumbColor={C.text} {...({ activeThumbColor: C.text } as object)} accessibilityLabel="Auto rest timer" />
          </View>
        </ApexCard>

        <Txt v="overline" style={styles.section}>About training load</Txt>
        <ApexCard style={{ gap: S.sm }}>
          <Txt v="bodySm">Training load is Apex’s internal programming number — not a medical or clinically validated measurement, and not an injury prediction.</Txt>
          <Txt v="bodySm">Basketball counts minutes × RPE, weighted by session type and split across body areas by jumping, sprinting and change of direction. Gym counts working sets by effort, reps and exercise. Plyometrics count contacts by intensity.</Txt>
          <Txt v="bodySm">Recommendations weigh today’s sessions, recent days above your normal, and this week against your usual week. Your recovery check-in adjusts how much changes — it never decides alone. Your schedule adds context only: planned sessions never count until you log them.</Txt>
          <Txt v="bodySm">Day labels: moderate ≥ {m} · high ≥ {h} · very high ≥ {e}.</Txt>
        </ApexCard>

        <Txt v="overline" style={styles.section}>Data</Txt>
        <ApexCard padded={false}>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Txt v="title">Stored on this device</Txt>
              <Txt v="bodySm">{data.instances.filter((i) => i.status === 'completed').length} sessions · {data.basketball.length} {data.basketball.length === 1 ? 'practice' : 'practices'} · works offline · nothing is sent anywhere</Txt>
            </View>
          </View>
          <Divider />
          <Button label="Reset all data" variant="ghost" onPress={() => setConfirm(true)} style={{ justifyContent: 'flex-start' }} />
        </ApexCard>
      </ScrollView>

      {day !== null && <DayEditor index={day} onClose={() => setDay(null)} />}
      <BottomSheet visible={confirm} onClose={() => setConfirm(false)} title="Reset all data?"
        footer={<Button label="Erase and restore program" variant="danger" onPress={async () => { await apex.resetAll(); setConfirm(false); goBack(); }} />}>
        <Txt v="body" color={C.text2}>Deletes every logged session, practice, record, template edit and profile answer on this device, then restores the original program. This can’t be undone.</Txt>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: S.sm, height: 56 },
  name: { fontFamily: F.displayBold, fontSize: 36, color: C.text, textTransform: 'uppercase', paddingVertical: S.sm, marginBottom: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  section: { marginTop: S.xxxl, marginBottom: S.sm, color: C.text },
  field: { marginTop: S.lg },
  fieldHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: S.sm },
  program: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.lg, borderRadius: R.lg, backgroundColor: C.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line },
  dayRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, minHeight: 52, paddingVertical: S.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.lg, minHeight: 64 },
  numRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 52 },
  numInput: { width: 84, height: 44, borderRadius: R.sm, backgroundColor: C.raised, color: C.text, paddingHorizontal: S.md, fontFamily: F.display, fontSize: 20, textAlign: 'right' },
  link: { minHeight: 44, justifyContent: 'center' },
});
