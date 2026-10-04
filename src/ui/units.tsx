// Weights are stored in kg. The athlete's units only change what is shown and typed.
import { fromUnits, stepIn, toUnits, type Units } from '@/domain/profile';
import { useApex } from '@/services/useApex';
import { Stepper } from './primitives';

/** Until the athlete chooses, Apex keeps showing kg (what it always used) — nothing is saved. */
export const useUnits = (): Units => useApex().data.profile.units ?? 'kg';

/** A stored kg weight as a number in the athlete's units: 61.235 kg → "135" lb. */
export function wt(kg: number, u: Units) {
  const v = toUnits(kg, u);
  return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-GB') : `${+v.toFixed(u === 'lb' ? 1 : 2)}`;
}
export const wtu = (kg: number, u: Units) => `${wt(kg, u)} ${u}`;

/** Engine text ("Keep 61.24 kg", "82.5 kg × 8") in the athlete's units. */
export const localize = (text: string, u: Units) => (u === 'kg' ? text : text.replace(/(\d+(?:\.\d+)?) kg\b/g, (_, n: string) => wtu(Number(n), u)));

/** The weight stepper: shows and steps in the athlete's units, reports kg. */
export function WeightStepper({ label = 'Weight', value, incrementKg, onChange, max = 1000, compact }: {
  label?: string; value: number; incrementKg: number; onChange: (kg: number) => void; max?: number; compact?: boolean;
}) {
  const u = useUnits();
  return (
    <Stepper label={compact ? u : label} unit={compact ? undefined : u} value={+toUnits(value, u).toFixed(u === 'lb' ? 1 : 2)}
      step={stepIn(incrementKg || 1, u)} max={Math.round(toUnits(max, u))} onChange={(v) => onChange(fromUnits(v, u))} />
  );
}
