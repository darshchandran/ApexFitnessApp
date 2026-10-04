// Weights are stored in kg. The athlete's units only change what is shown and typed.
import { fromUnits, stepIn, toUnits, type Units } from '@/domain/profile';
import { useApex } from '@/services/useApex';
import { Stepper } from './primitives';

export { localize, wt, wtu } from '@/domain/profile';

/** Until the athlete chooses, Apex keeps showing kg (what it always used) — nothing is saved. */
export const useUnits = (): Units => useApex().data.profile.units ?? 'kg';

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
