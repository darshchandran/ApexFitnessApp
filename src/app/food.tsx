import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { foodById, gramsOf, macrosOf, searchFoods, type Food, type Macros, type MealSlot } from '@/domain/foods';
import { MEAL_LABEL } from '@/domain/nutrition';
import { apex, useApex } from '@/services/useApex';
import { shortDate } from '@/ui/format';
import { goBack } from '@/ui/nav';
import { ApexCard, Button, Chip, Divider, IconButton, ListRow, Stepper, Txt } from '@/ui/primitives';
import { C, F, GUTTER, R, S } from '@/ui/theme';

const SLOTS = Object.keys(MEAL_LABEL) as MealSlot[];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const g = (n: number) => `${Math.round(n)}`;
const isWeight = (unit: string) => unit === 'g' || unit === 'ml';
const stepOf = (unit: string) => (isWeight(unit) ? 10 : 0.5);

/** A quantity in a new unit that keeps about the same amount of food. */
function convert(food: Food, qty: number, from: string, to: string) {
  const grams = gramsOf(food, qty, from) ?? 0;
  const per = gramsOf(food, 1, to) ?? 1;
  return isWeight(to) ? Math.max(10, Math.round(grams / 10) * 10) : Math.max(0.5, Math.round((grams / per) * 2) / 2);
}

function MacroLine({ m }: { m: Macros }) {
  return (
    <View style={styles.macros} accessible accessibilityLabel={`${m.kcal} kcal, ${g(m.protein)} grams protein, ${g(m.carbs)} carbs, ${g(m.fat)} fat`}>
      {([['kcal', m.kcal, ''], ['Protein', m.protein, ' g'], ['Carbs', m.carbs, ' g'], ['Fat', m.fat, ' g']] as const).map(([label, v, unit]) => (
        <View key={label} style={{ flex: 1 }}>
          <Txt v="overline">{label}</Txt>
          <Txt v="num">{g(v)}{unit && <Txt v="label">{unit}</Txt>}</Txt>
        </View>
      ))}
    </View>
  );
}

const num = (t: string) => {
  const n = Number(t.replace(',', '.'));
  return t.trim() && Number.isFinite(n) ? n : undefined;
};

/** Add a food to a meal (from APEX's table, or the athlete's own), or edit or remove a logged one. */
export default function FoodScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ date?: string; meal?: string; entry?: string }>();
  const { data } = useApex();
  const today = apex.today();
  const existing = params.entry ? data.foodLog.find((e) => e.id === params.entry) : undefined;
  const date = existing?.date ?? (params.date && ISO.test(params.date) && params.date <= today ? params.date : today);
  const meal = existing?.meal ?? (SLOTS.includes(params.meal as MealSlot) ? (params.meal as MealSlot) : 'snacks');

  const [query, setQuery] = useState('');
  const [food, setFood] = useState<Food | undefined>(existing?.foodId ? foodById(existing.foodId) : undefined);
  const [unit, setUnit] = useState(existing?.unit ?? '');
  const [qty, setQty] = useState(existing?.qty ?? 1);
  const [custom, setCustom] = useState<{ name: string; kcal: string; protein: string; carbs: string; fat: string } | null>(null);

  const recent = useMemo(() => {
    const ids = [...data.foodLog].sort((a, b) => b.loggedAt.localeCompare(a.loggedAt)).flatMap((e) => (e.foodId ? [e.foodId] : []));
    return [...new Set(ids)].slice(0, 6).flatMap((id) => foodById(id) ?? []);
  }, [data.foodLog]);
  const results = useMemo(() => searchFoods(query, 60), [query]);

  const pick = (f: Food) => { setFood(f); setUnit(f.units[0].unit); setQty(f.serve); };
  const grams = food ? gramsOf(food, qty, unit) : undefined;
  const preview: Macros | undefined = food && grams ? macrosOf(food, grams)
    : existing && !existing.foodId ? { kcal: Math.round((existing.kcal * qty) / existing.qty), protein: (existing.protein * qty) / existing.qty, carbs: (existing.carbs * qty) / existing.qty, fat: (existing.fat * qty) / existing.qty }
      : undefined;
  const customOk = !!custom?.name.trim() && num(custom.kcal) !== undefined && num(custom.kcal)! <= 3000;

  const save = () => {
    if (existing) apex.updateFood(existing.id, qty, food ? unit : undefined);
    else if (food) apex.logFood({ date, meal, foodId: food.id, qty, unit });
    else if (custom && customOk) apex.logFood({ date, meal, qty: 1, custom: { name: custom.name, kcal: num(custom.kcal)!, protein: num(custom.protein), carbs: num(custom.carbs), fat: num(custom.fat) } });
    else return;
    goBack();
  };

  const title = existing ? 'Edit food' : `Add to ${MEAL_LABEL[meal].toLowerCase()}`;
  const choosing = !existing && !food && !custom;

  return (
    <KeyboardAvoidingView style={[styles.screen, { paddingTop: insets.top }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Txt v="overline">{MEAL_LABEL[meal]} · {date === today ? 'Today' : shortDate(date)}</Txt>
        <IconButton icon="close" label="Close without saving" onPress={goBack} />
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: S.xxl }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <Txt v="h1" accessibilityRole="header">{title}</Txt>

        {choosing && (
          <>
            <TextInput value={query} onChangeText={setQuery} placeholder="Search: dal, anda, roti, chicken…" placeholderTextColor={C.text3} autoFocus={Platform.OS === 'web'}
              returnKeyType="search" maxLength={40} style={styles.search} accessibilityLabel="Search foods" />
            {!query && recent.length > 0 && (
              <>
                <Txt v="overline" style={styles.label}>Recent</Txt>
                <ApexCard padded={false}>
                  {recent.map((f, i) => <View key={f.id}>{i > 0 && <Divider inset={16} />}<FoodRow food={f} onPress={() => pick(f)} /></View>)}
                </ApexCard>
              </>
            )}
            <Txt v="overline" style={styles.label}>{query ? 'Results' : 'All foods'}</Txt>
            <ApexCard padded={false}>
              {results.map((f, i) => <View key={f.id}>{i > 0 && <Divider inset={16} />}<FoodRow food={f} onPress={() => pick(f)} /></View>)}
              {!results.length && <Txt v="bodySm" style={{ padding: S.lg }}>No match in APEX’s food table. Add it as your own food below.</Txt>}
            </ApexCard>
            <Button label="Add your own food" variant="secondary" icon="plus" style={{ marginTop: S.lg }}
              onPress={() => setCustom({ name: query.trim(), kcal: '', protein: '', carbs: '', fat: '' })} />
          </>
        )}

        {food && (
          <View style={{ marginTop: S.lg, gap: S.lg }}>
            <View style={{ gap: 2 }}>
              <Txt v="title">{food.name}</Txt>
              <Txt v="bodySm">{food.source === 'recipe' ? 'Home-style recipe estimate' : 'Reference values'} · per 100 {food.base}: {food.per100.kcal} kcal, {food.per100.protein} g protein</Txt>
            </View>
            {food.units.length > 1 && (
              <View style={styles.wrap}>
                {food.units.map((x) => (
                  <Chip key={x.unit} label={isWeight(x.unit) ? x.unit : `${x.unit} (${x.grams} ${food.base})`} selected={x.unit === unit}
                    onPress={() => { if (x.unit !== unit) { setQty(convert(food, qty, unit, x.unit)); setUnit(x.unit); } }} style={{ paddingHorizontal: 12 }} />
                ))}
              </View>
            )}
            <Stepper label="Amount" unit={unit} value={qty} step={stepOf(unit)} min={stepOf(unit)} max={isWeight(unit) ? 3000 : 50} onChange={setQty} />
            {preview && <MacroLine m={preview} />}
            {!existing && <Button label="Choose another food" variant="ghost" size="md" onPress={() => setFood(undefined)} />}
          </View>
        )}

        {existing && !existing.foodId && (
          <View style={{ marginTop: S.lg, gap: S.lg }}>
            <View style={{ gap: 2 }}>
              <Txt v="title">{existing.name}</Txt>
              <Txt v="bodySm">Your own food: your estimate for one serving.</Txt>
            </View>
            <Stepper label="Servings" value={qty} step={0.5} min={0.5} max={20} onChange={setQty} />
            {preview && <MacroLine m={preview} />}
          </View>
        )}

        {custom && (
          <View style={{ marginTop: S.lg, gap: S.md }}>
            <Txt v="bodySm">For something not in APEX’s table. Calories are enough — add macros if you know them (a label, or your best estimate).</Txt>
            <TextInput value={custom.name} onChangeText={(name) => setCustom({ ...custom, name })} placeholder="Name (e.g. mess thali)" placeholderTextColor={C.text3}
              maxLength={60} style={styles.search} accessibilityLabel="Food name" />
            {(['kcal', 'protein', 'carbs', 'fat'] as const).map((k) => (
              <View key={k} style={styles.numRow}>
                <Txt v="body" style={{ flex: 1 }}>{k === 'kcal' ? 'Calories' : k[0].toUpperCase() + k.slice(1)}{k === 'kcal' ? '' : ' (optional)'}</Txt>
                <TextInput value={custom[k]} onChangeText={(t) => setCustom({ ...custom, [k]: t.replace(/[^0-9.,]/g, '') })} keyboardType="decimal-pad" maxLength={5}
                  placeholder="—" placeholderTextColor={C.text3} style={styles.numInput} accessibilityLabel={k === 'kcal' ? 'Calories, kcal' : `${k}, grams`} />
                <Txt v="label" style={{ width: 32 }}>{k === 'kcal' ? 'kcal' : 'g'}</Txt>
              </View>
            ))}
            <Button label="Back to the food table" variant="ghost" size="md" onPress={() => setCustom(null)} />
          </View>
        )}
      </ScrollView>
      {!choosing && (
        <View style={[styles.footer, { paddingBottom: insets.bottom + S.md }]}>
          {existing && <Button label="Remove" variant="danger" icon="trash" onPress={() => { apex.removeFood(existing.id); goBack(); }} style={{ flex: 1 }} />}
          <Button label={existing ? 'Save' : 'Add'} icon="check" onPress={save} disabled={custom ? !customOk : !preview} style={{ flex: 2 }} />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

function FoodRow({ food, onPress }: { food: Food; onPress: () => void }) {
  const serve = macrosOf(food, gramsOf(food, food.serve)!);
  const u = food.units[0].unit;
  return <ListRow title={food.name} subtitle={`${food.serve} ${u} · ${serve.kcal} kcal · ${g(serve.protein)} g protein`} onPress={onPress} accessibilityLabel={`${food.name}. Select`} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: GUTTER, paddingRight: S.sm, height: 56 },
  label: { marginTop: S.xl, marginBottom: S.sm },
  search: { marginTop: S.lg, height: 52, borderRadius: R.md, backgroundColor: C.raised, color: C.text, paddingHorizontal: S.lg, fontFamily: F.regular, fontSize: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  macros: { flexDirection: 'row', gap: S.sm, padding: S.lg, borderRadius: R.lg, backgroundColor: C.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line },
  numRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 52 },
  numInput: { width: 96, height: 44, borderRadius: R.sm, backgroundColor: C.raised, color: C.text, paddingHorizontal: S.md, fontFamily: F.display, fontSize: 20, textAlign: 'right' },
  footer: { flexDirection: 'row', gap: S.sm, paddingHorizontal: GUTTER, paddingTop: S.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line, backgroundColor: C.bg },
});
