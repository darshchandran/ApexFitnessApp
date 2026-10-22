import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ageOn, LIFESTYLE, nutritionTargets, STARTING_PROFILE, weighIns, type Lifestyle, type NutritionProfile, type Sex } from '@/domain/nutrition';
import { apex, useApex } from '@/services/useApex';
import { goBack } from '@/ui/nav';
import { ApexCard, Button, Chip, Divider, IconButton, Segmented, Stepper, Txt } from '@/ui/primitives';
import { WeightStepper } from '@/ui/units';
import { C, F, GUTTER, S } from '@/ui/theme';

type Own = { kcal: number; protein: number; fat: number };

/**
 * Nutrition setup and profile: what the targets are calculated from, the calculation itself, and
 * the athlete's own targets if they prefer them. Starts from what the athlete told APEX.
 */
export default function NutritionProfileScreen() {
  const { data } = useApex();
  const insets = useSafeAreaInsets();
  const today = apex.today();
  const p = data.nutrition.profile;
  const latest = weighIns(data).at(-1)?.kg;

  const [age, setAge] = useState(ageOn(p, today) ?? STARTING_PROFILE.age);
  const [sex, setSex] = useState<Sex | 'unset'>(p.sex ?? 'unset');
  const [height, setHeight] = useState(data.profile.heightCm ?? STARTING_PROFILE.heightCm);
  const [weight, setWeight] = useState(latest ?? STARTING_PROFILE.weightKg);
  const [weighed, setWeighed] = useState(latest === undefined); // a new weigh-in only if there is none or it was changed
  const [target, setTarget] = useState(data.profile.targetBodyweightKg ?? STARTING_PROFILE.targetKg);
  const [lifestyle, setLifestyle] = useState<Lifestyle>(p.lifestyle ?? STARTING_PROFILE.lifestyle);
  const [budget, setBudget] = useState<'budget' | 'moderate'>(p.budget ?? STARTING_PROFILE.budget);
  const [own, setOwn] = useState<Own | null>(p.override?.kcal ? { kcal: p.override.kcal, protein: p.override.protein ?? 0, fat: p.override.fat ?? 0 } : null);

  const draft: NutritionProfile = {
    ...p, age, ageAsOf: today, sex: sex === 'unset' ? undefined : sex, lifestyle, budget, diet: 'non-vegetarian', avoid: p.avoid ?? [...STARTING_PROFILE.avoid],
    override: own ? { kcal: own.kcal, ...(own.protein && { protein: own.protein }), ...(own.fat && { fat: own.fat }) } : undefined,
  };
  // the calculation as it will be once saved (and without the athlete's own values)
  const targetsWith = (profile: NutritionProfile) => {
    const r = nutritionTargets({
      ...data, profile: { ...data.profile, heightCm: height }, nutrition: { ...data.nutrition, profile },
      bodyMetrics: weighed ? [...data.bodyMetrics.filter((m) => !(m.kind === 'bodyweight' && m.date === today)), { id: 'draft', date: today, kind: 'bodyweight', value: weight }] : data.bodyMetrics,
    }, today);
    return r.ok ? r.targets : undefined;
  };
  const calc = targetsWith(draft);
  const auto = targetsWith({ ...draft, override: undefined });

  const save = () => {
    apex.saveNutrition({ profile: draft, heightCm: height, targetKg: target, weightKg: weighed ? weight : undefined });
    goBack();
  };

  const row = (label: string, value: string, strong = false) => (
    <View style={styles.calcRow} key={label}>
      <Txt v={strong ? 'title' : 'body'} style={{ flex: 1 }} color={strong ? C.text : C.text2}>{label}</Txt>
      <Txt v="label" color={C.text} style={strong ? { fontFamily: F.semibold, fontSize: 15 } : undefined}>{value}</Txt>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top }}>
      <View style={styles.header}>
        <IconButton icon="chevron-left" label="Back without saving" onPress={goBack} />
        <Txt v="overline">Nutrition profile</Txt>
        <View style={{ width: 48 }} />
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: insets.bottom + S.huge }} keyboardShouldPersistTaps="handled">
        <Txt v="h1" accessibilityRole="header">Your targets</Txt>
        <Txt v="bodySm" style={{ marginTop: 4 }}>Goal: gain weight gradually and build muscle while keeping your basketball sharp. Stays on this device.</Txt>

        <Txt v="overline" style={styles.section}>About you</Txt>
        <View style={styles.pair}>
          <Stepper label="Age" value={age} step={1} min={13} max={90} integer onChange={setAge} />
          <Stepper label="Height" unit="cm" value={height} step={1} min={120} max={230} integer onChange={setHeight} />
        </View>
        <Txt v="overline" style={styles.field}>Sex · only for the resting-energy equation</Txt>
        <Segmented label="Sex" options={['male', 'female', 'unset'] as const} value={sex} onChange={setSex} format={(v) => (v === 'unset' ? 'NOT SET' : v.toUpperCase())} height={44} />
        {sex === 'unset' && <Txt v="bodySm" style={{ marginTop: 6 }}>Not set: APEX uses the middle of the two equations and labels the target as an estimate.</Txt>}
        <View style={[styles.pair, styles.field]}>
          <WeightStepper label="Weight now" value={weight} incrementKg={0.1} max={250} onChange={(kg) => { setWeight(kg); setWeighed(true); }} />
          <WeightStepper label="Target" value={target} incrementKg={0.5} max={200} onChange={setTarget} />
        </View>
        {!weighed && latest !== undefined && <Txt v="bodySm" style={{ marginTop: 6 }}>From your body log. Change it to log today’s weigh-in.</Txt>}

        <Txt v="overline" style={styles.field}>Daily life outside training</Txt>
        <Segmented label="Daily life" options={['low', 'moderate', 'high'] as const} value={lifestyle} onChange={setLifestyle} format={(v) => LIFESTYLE[v].label.toUpperCase()} height={44} />
        <Txt v="bodySm" style={{ marginTop: 6 }}>{LIFESTYLE[lifestyle].sub}. Training is added separately, from the sessions you log.</Txt>

        <Txt v="overline" style={styles.section}>Food</Txt>
        <Txt v="body">Non-vegetarian · never beef · no supplements needed</Txt>
        <Txt v="overline" style={styles.field}>Budget</Txt>
        <Segmented label="Budget" options={['budget', 'moderate'] as const} value={budget} onChange={setBudget} format={(v) => (v === 'budget' ? 'BUDGET' : 'MODERATE')} height={44} />
        <Txt v="bodySm" style={{ marginTop: 6 }}>{budget === 'budget' ? 'Suggestions use the cheapest staples: eggs, dal, soya, chana, curd, rice, roti.' : 'Suggestions also include chicken, fish, paneer and peanut butter.'}</Txt>

        <Txt v="overline" style={styles.section}>How your target is worked out</Txt>
        {calc ? (
          <ApexCard padded={false}>
            <View style={{ padding: S.lg, paddingBottom: S.sm }}>
              {row('Resting energy (BMR)', calc.bmrRange ? `${calc.bmr} kcal (${calc.bmrRange[0]}–${calc.bmrRange[1]})` : `${calc.bmr} kcal`)}
              {row(`× daily life (${LIFESTYLE[lifestyle].label.toLowerCase()})`, `× ${calc.lifestyleFactor}`)}
              {row(`+ training, 14-day average (${calc.trainingSessions} logged)`, `+${calc.trainingPerDay} kcal`)}
              {row('= Maintenance', `${calc.maintenance} kcal`, true)}
              {row('+ Gradual gain', `+${calc.surplus} kcal`)}
              {calc.adjustment !== 0 && row('+ Weight-trend adjustments', `${calc.adjustment > 0 ? '+' : ''}${calc.adjustment} kcal`)}
              {row(own ? 'Calculated target' : '= Daily target', `${auto?.kcal ?? calc.kcal} kcal`, !own)}
              {own && row('= Your target', `${calc.kcal} kcal`, true)}
            </View>
            <Divider />
            <View style={{ padding: S.lg, paddingTop: S.sm }}>
              {row('Protein', `${calc.protein} g${calc.overridden.includes('protein') ? ' (yours)' : ''}`)}
              {row('Carbohydrate', `${calc.carbs} g`)}
              {row('Fat', `${calc.fat} g${calc.overridden.includes('fat') ? ' (yours)' : ''}`)}
            </View>
          </ApexCard>
        ) : (
          <Txt v="bodySm">Add your age, height and weight to calculate targets.</Txt>
        )}
        {calc?.notes.map((n) => <Txt key={n} v="bodySm" style={{ marginTop: S.sm }}>{n}</Txt>)}

        <Txt v="overline" style={styles.section}>Your own targets</Txt>
        <Chip label={own ? 'Using my own targets' : 'Use my own targets'} selected={!!own}
          onPress={() => setOwn(own ? null : { kcal: auto?.kcal ?? 2500, protein: auto?.protein ?? 120, fat: auto?.fat ?? 70 })} style={{ paddingHorizontal: 16, alignSelf: 'flex-start' }} />
        {own && (
          <View style={{ gap: S.md, marginTop: S.md }}>
            <Stepper label="Calories" unit="kcal" value={own.kcal} step={50} min={1200} max={6000} integer onChange={(kcal) => setOwn({ ...own, kcal })} />
            <View style={styles.pair}>
              <Stepper label="Protein" unit="g" value={own.protein} step={5} min={40} max={400} integer onChange={(protein) => setOwn({ ...own, protein })} />
              <Stepper label="Fat" unit="g" value={own.fat} step={5} min={20} max={300} integer onChange={(fat) => setOwn({ ...own, fat })} />
            </View>
            <Txt v="bodySm">Carbohydrate fills the rest of your calories. Weight-trend suggestions still appear, but your own calories stay until you change them.</Txt>
          </View>
        )}

        <Button label={p.setupAt ? 'Save' : 'Start nutrition'} icon="check" onPress={save} disabled={!calc} style={{ marginTop: S.xxxl }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: S.sm, height: 56 },
  section: { marginTop: S.xxxl, marginBottom: S.sm, color: C.text },
  field: { marginTop: S.lg, marginBottom: S.sm },
  pair: { flexDirection: 'row', gap: S.md },
  calcRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 36 },
});
