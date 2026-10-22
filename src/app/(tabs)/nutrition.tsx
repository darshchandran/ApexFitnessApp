import { useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { amountText, FOOD_DATA_NOTE, type MealSlot, type PreGymWindow } from '@/domain/foods';
import {
  DAY_LABEL, dayLog, dayPlan, dayType, MAIN_MEALS, MEAL_LABEL, nutritionTargets, remaining, STARTING_PROFILE, totalsOf, weighIns, weightTrend,
  WINDOW_LABEL, type DayType, type FoodEntry, type PlannedMeal, type TrendStatus,
} from '@/domain/nutrition';
import { fromUnits, toUnits } from '@/domain/profile';
import { addDays } from '@/domain/util';
import { apex, useApex } from '@/services/useApex';
import { LogSheet } from '@/ui/BottomSheet';
import { shortDate } from '@/ui/format';
import { go } from '@/ui/nav';
import { ApexCard, Button, Divider, IconButton, ListRow, Metric, ProgressBar, Screen, SectionHeader, Segmented, StatusChip, Txt } from '@/ui/primitives';
import { ProgressRing, Sparkline } from '@/ui/training';
import { useUnits, wt } from '@/ui/units';
import { C, S } from '@/ui/theme';

const WINDOWS: PreGymWindow[] = ['under45', '1to2h', '2to3h'];
const WINDOW_NOTE: Record<PreGymWindow, string> = {
  under45: 'Small and quick to digest: mostly carbs, little fat or fibre.',
  '1to2h': 'A light meal: carbs with some protein.',
  '2to3h': 'A small regular meal: carbs, protein and a little fat.',
};
const TREND_LABEL: Record<TrendStatus, string> = { 'need-data': 'Not enough data', losing: 'Losing', slow: 'Slow', 'on-track': 'On track', fast: 'Too fast' };
const g = (n: number) => `${Math.round(n)}`;

function dayDetail(day: DayType, past: boolean) {
  const part = (name: string, s: DayType['gym']) => (s.done ? `${name} logged` : s.planned ? `${name} planned` : '') + (s.time && (s.done || s.planned) ? ` · ${s.time}` : '');
  const parts = [part('Gym', day.gym), part('Basketball', day.basketball)].filter(Boolean);
  return parts.join(' · ') || (past ? 'No training logged' : 'No training planned');
}

/** Food logged, a suggestion (never counted until logged), and quick ways to add. */
function MealSection({ slot, date, entries, suggestion, copyFrom, children }: {
  slot: MealSlot; date: string; entries: FoodEntry[]; suggestion?: PlannedMeal; copyFrom?: string; children?: ReactNode;
}) {
  const total = totalsOf(entries);
  return (
    <>
      <SectionHeader title={`${MEAL_LABEL[slot]}${entries.length ? ` · ${total.kcal} kcal` : ''}`} action="Add food" onAction={() => go.food(date, slot)} />
      {children}
      <ApexCard padded={false}>
        {entries.map((e, i) => (
          <View key={e.id}>
            {i > 0 && <Divider inset={16} />}
            <ListRow title={e.name} subtitle={`${amountText(e.qty, e.unit)} · ${g(e.protein)} g protein${e.plan ? ' · from suggestion' : ''}`}
              right={<Txt v="label" color={C.text}>{e.kcal} kcal</Txt>} onPress={() => go.food(date, slot, e.id)} accessibilityLabel={`${e.name}, ${amountText(e.qty, e.unit)}, ${e.kcal} kcal. Edit`} />
          </View>
        ))}
        {suggestion && !suggestion.eaten && (
          <View style={[styles.suggestion, entries.length > 0 && styles.topLine]}>
            <Txt v="overline">Suggested · not logged</Txt>
            <Txt v="title">{suggestion.name}</Txt>
            {suggestion.items.map((i) => (
              <View key={i.foodId} style={styles.between}>
                <Txt v="bodySm" color={C.text} style={{ flex: 1 }} numberOfLines={1}>{i.name}</Txt>
                <Txt v="bodySm">{amountText(i.qty, i.unit)} · {i.kcal} kcal</Txt>
              </View>
            ))}
            <Txt v="label" color={C.text} style={{ marginTop: 2 }}>{suggestion.kcal} kcal · {g(suggestion.protein)} g protein · {g(suggestion.carbs)} g carbs · {g(suggestion.fat)} g fat</Txt>
            <View style={styles.row}>
              <Button label="Ate this" icon="check" size="md" style={{ flex: 1 }} onPress={() => apex.eatSuggestion(date, slot)} accessibilityLabel={`Log ${suggestion.name} as eaten`} />
              {suggestion.options > 1 && <Button label="Swap" icon="swap" variant="secondary" size="md" onPress={() => apex.swapSuggestion(date, slot)} accessibilityLabel={`Show another ${MEAL_LABEL[slot].toLowerCase()} suggestion`} />}
            </View>
          </View>
        )}
        {!entries.length && !suggestion && <Txt v="bodySm" style={styles.empty}>Nothing logged.</Txt>}
        {copyFrom && (
          <View style={styles.topLine}>
            <ListRow title={`Copy yesterday’s ${MEAL_LABEL[slot].toLowerCase()}`} onPress={() => apex.copyMeal(copyFrom, slot, date)} />
          </View>
        )}
      </ApexCard>
    </>
  );
}

export default function Nutrition() {
  const { data } = useApex();
  const u = useUnits();
  const today = apex.today();
  const [date, setDate] = useState(today);
  const [weighing, setWeighing] = useState(false);
  const isToday = date === today;

  const t = useMemo(() => nutritionTargets(data, date), [data, date]);
  const log = useMemo(() => dayLog(data, date), [data, date]);
  const yesterday = useMemo(() => dayLog(data, addDays(date, -1)), [data, date]);
  const day = useMemo(() => dayType(data, date, today), [data, date, today]);
  const plan = useMemo(() => (t.ok && isToday ? dayPlan(data, date, today, t.targets) : undefined), [data, date, today, t, isToday]);
  const trend = useMemo(() => weightTrend(data, today), [data, today]);
  const weights = useMemo(() => weighIns(data), [data]);
  const setUp = !!data.nutrition.profile.setupAt;

  const target = t.ok ? t.targets : undefined;
  const left = target && remaining(target, log.totals);
  const current = trend.weekKg ?? trend.latest?.kg;
  const goal = data.profile.targetBodyweightKg;
  const start = weights[0]?.kg;
  const toGo = current !== undefined && goal ? goal - current : undefined;
  const progress = start !== undefined && current !== undefined && goal && goal !== start ? (current - start) / (goal - start) : 0;
  const copyFrom = (slot: MealSlot) => (!log.byMeal[slot].length && yesterday.byMeal[slot].length ? addDays(date, -1) : undefined);

  return (
    <Screen>
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <Txt v="overline">Nutrition</Txt>
          <Txt v="h2" style={{ marginTop: 2 }} accessibilityRole="header">{isToday ? 'Today' : shortDate(date)}</Txt>
        </View>
        <IconButton icon="chevron-left" label="Previous day" onPress={() => setDate(addDays(date, -1))} />
        <IconButton icon="chevron-right" label="Next day" onPress={() => { if (!isToday) setDate(addDays(date, 1)); }} color={isToday ? C.text3 : C.text} style={isToday ? { opacity: 0.4 } : undefined} />
        <IconButton icon="settings" label="Nutrition profile and targets" onPress={go.nutritionProfile} />
      </View>
      <View style={[styles.row, { marginTop: S.sm, alignItems: 'center' }]}>
        <StatusChip label={DAY_LABEL[day.kind]} tone={day.kind === 'rest' ? 'neutral' : 'accent'} />
        <Txt v="bodySm" style={{ flex: 1 }} numberOfLines={2}>{dayDetail(day, date < today)}</Txt>
      </View>

      {!setUp && (
        <ApexCard style={{ marginTop: S.xl, gap: S.sm }}>
          <Txt v="h3">Set up nutrition</Txt>
          <Txt v="bodySm">
            APEX estimates calorie and macro targets from your age, height, weight and training. It starts from what you told it — {STARTING_PROFILE.age}, {STARTING_PROFILE.heightCm} cm,{' '}
            {STARTING_PROFILE.weightKg} kg, aiming for about {STARTING_PROFILE.targetKg} kg — and you can change any of it.
          </Txt>
          <Button label="Set up" onPress={go.nutritionProfile} style={{ marginTop: S.sm }} />
        </ApexCard>
      )}

      {target && left && (
        <>
          <SectionHeader title="Calories" action="How it’s worked out" onAction={go.nutritionProfile} />
          <ApexCard style={{ gap: S.lg }}>
            <View style={[styles.row, { alignItems: 'center', gap: S.xl }]}>
              <ProgressRing size={116} value={log.totals.kcal / target.kcal} label={`${log.totals.kcal} of ${target.kcal} kcal eaten`}>
                <Txt v="num">{Math.abs(left.kcal)}</Txt>
                <Txt v="overline">{left.kcal >= 0 ? 'kcal left' : 'kcal over'}</Txt>
              </ProgressRing>
              <View style={{ flex: 1, gap: S.md }}>
                <Metric label="Eaten" value={log.totals.kcal} unit="kcal" />
                <Metric label="Target" value={target.kcal} unit="kcal" sub={target.overridden.includes('kcal') ? 'Your own target' : `Maintenance ~${target.maintenance} + ${target.surplus + target.adjustment} gain`} />
              </View>
            </View>
            {(['protein', 'carbs', 'fat'] as const).map((k) => (
              <View key={k} style={{ gap: 6 }} accessible accessibilityLabel={`${k}: ${g(log.totals[k])} of ${target[k]} grams`}>
                <View style={styles.between}>
                  <Txt v="label" color={C.text}>{k === 'protein' ? 'Protein' : k === 'carbs' ? 'Carbs' : 'Fat'}</Txt>
                  <Txt v="label">{g(log.totals[k])} / {target[k]} g</Txt>
                </View>
                <ProgressBar value={log.totals[k] / target[k]} color={k === 'protein' ? C.accent : C.text} height={5} />
              </View>
            ))}
            <Txt v="bodySm" color={C.text3}>Estimates, not prescriptions — adjust them from your weight trend, training and recovery. Suggestions don’t count until you log them.</Txt>
          </ApexCard>
        </>
      )}

      <SectionHeader title="Weight" action="Log weight" onAction={() => setWeighing(true)} />
      <ApexCard style={{ gap: S.md }}>
        <View style={[styles.row, { alignItems: 'flex-start' }]}>
          <View style={{ flex: 1 }}>
            <Metric label={trend.weekKg !== undefined ? 'This week' : 'Latest'} value={current !== undefined ? wt(current, u) : '—'} unit={current !== undefined ? u : undefined}
              sub={trend.latest && trend.weekKg !== undefined ? `Last weigh-in ${wt(trend.latest.kg, u)} ${u}` : trend.latest ? shortDate(trend.latest.date) : 'No weigh-ins yet'} />
          </View>
          <View style={{ flex: 1 }}>
            <Metric label="Target" value={goal ? wt(goal, u) : '—'} unit={goal ? u : undefined} sub={toGo !== undefined ? (Math.abs(toGo) < 0.1 ? 'Reached' : `${wt(Math.abs(toGo), u)} ${u} to ${toGo > 0 ? 'gain' : 'lose'}`) : undefined} />
          </View>
          <Sparkline values={weights.slice(-30).map((w) => w.kg)} width={96} />
        </View>
        {goal !== undefined && start !== undefined && <ProgressBar value={progress} height={4} />}
        <View style={[styles.row, { alignItems: 'center' }]}>
          <StatusChip label={TREND_LABEL[trend.status]} tone={trend.status === 'on-track' ? 'solid' : trend.status === 'need-data' ? 'neutral' : 'accent'} />
          {trend.ratePerWeek !== undefined && <Txt v="label" color={C.text}>{trend.ratePerWeek >= 0 ? '+' : '−'}{wt(Math.abs(trend.ratePerWeek), u)} {u} / week</Txt>}
        </View>
        <Txt v="bodySm">{trend.note}</Txt>
        {trend.suggestion !== 0 && target?.overridden.includes('kcal') && (
          <Txt v="bodySm" color={C.text}>You set your own calories — change them in your nutrition profile if you want to follow this.</Txt>
        )}
        {trend.suggestion !== 0 && target && !target.overridden.includes('kcal') && (
          <Button label={`Apply ${trend.suggestion > 0 ? '+' : '−'}${Math.abs(trend.suggestion)} kcal a day`} variant="secondary" size="md" onPress={() => apex.applyTrendAdjustment()} />
        )}
      </ApexCard>

      {MAIN_MEALS.map((slot) => (
        <MealSection key={slot} slot={slot} date={date} entries={log.byMeal[slot]} suggestion={plan?.meals.find((m) => m.slot === slot)} copyFrom={copyFrom(slot)} />
      ))}
      {plan && plan.proteinGap >= 10 && (
        <Txt v="bodySm" style={{ marginTop: S.sm }}>Today’s suggestions are about {plan.proteinGap} g short of your protein target — add a katori of curd, 2 eggs or a handful of roasted chana.</Txt>
      )}

      {(plan?.preGym || log.byMeal.preGym.length > 0) && (
        <MealSection slot="preGym" date={date} entries={log.byMeal.preGym} suggestion={plan?.preGym} copyFrom={copyFrom('preGym')}>
          {plan?.preGym && (
            <View style={{ marginBottom: S.md, gap: S.sm }}>
              <Txt v="bodySm">Separate from your four meals. How long before training will you eat?</Txt>
              <Segmented label="Time before training" options={WINDOWS} value={plan.preGym.window} onChange={(w) => apex.setPreGymWindow(date, w)} format={(w) => WINDOW_LABEL[w]} height={44} />
              <Txt v="bodySm" color={C.text3}>{WINDOW_NOTE[plan.preGym.window]}</Txt>
            </View>
          )}
        </MealSection>
      )}

      <Txt v="bodySm" color={C.text3} style={{ marginTop: S.xxl }}>{FOOD_DATA_NOTE}</Txt>
      <Txt v="bodySm" color={C.text3} style={{ marginTop: S.sm }}>General guidance for a healthy athlete, not medical advice. With a medical condition or an eating concern, check with a doctor or a registered dietitian.</Txt>

      {weighing && (
        <LogSheet title="Log weight" options={[{ kind: 'bodyweight', label: 'Bodyweight', unit: u, initial: +toUnits(weights.at(-1)?.kg ?? STARTING_PROFILE.weightKg, u).toFixed(1) }]}
          onSave={(_, v) => apex.addBodyMetric('bodyweight', fromUnits(v, u))} onClose={() => setWeighing(false)} />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  row: { flexDirection: 'row', gap: S.sm },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  suggestion: { padding: S.lg, gap: 6 },
  topLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line },
  empty: { padding: S.lg },
});
