import { Platform } from 'react-native';

import type { AdaptationStatus } from '@/domain/logbook';
import type { LoadBand } from '@/domain/types';

// Dark-first tokens. One accent, used for action, progress, PRs and adaptation — nothing else.
export const C = {
  bg: '#0A0A0B',
  surface: '#121214',
  raised: '#1A1A1D',
  pressed: '#222226',
  line: '#232327',
  lineStrong: '#34343A',
  text: '#F4F4F5',
  text2: '#A8A8B0',
  text3: '#7C7C85',
  accent: '#FF6A2B',
  accentSoft: 'rgba(255,106,43,0.14)',
  onAccent: '#0A0A0B',
  danger: '#FF5A4E',
  dangerSoft: 'rgba(255,90,78,0.14)',
  scrim: 'rgba(0,0,0,0.6)',
} as const;

// On web a font that hasn't arrived yet falls back to the browser default (serif) — give it a
// sans-serif stack instead. Native bundles the fonts and needs the exact family name.
const fam = (name: string, fallback: string) => (Platform.OS === 'web' ? `${name}, ${fallback}` : name);
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const NARROW = '"Arial Narrow", "Roboto Condensed", system-ui, sans-serif';

export const F = {
  regular: fam('Inter_400Regular', SANS),
  medium: fam('Inter_500Medium', SANS),
  semibold: fam('Inter_600SemiBold', SANS),
  bold: fam('Inter_700Bold', SANS),
  display: fam('BarlowCondensed_600SemiBold', NARROW),
  displayBold: fam('BarlowCondensed_700Bold', NARROW),
  displayMedium: fam('BarlowCondensed_500Medium', NARROW),
} as const;

export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32, huge: 48 } as const;
export const R = { sm: 8, md: 12, lg: 16, pill: 999 } as const;
export const GUTTER = 20;
export const TOUCH = 48; // minimum touch target

export type Tone = 'neutral' | 'accent' | 'danger' | 'solid';

/** Tone for each session status label (see adaptationStatus). */
export const statusTone: Record<AdaptationStatus, Tone> = {
  'As planned': 'neutral',
  Adapted: 'accent',
  'Plan kept': 'neutral',
  Alternative: 'neutral',
  'Recovery day': 'neutral',
  'Rest advised': 'danger',
};

export const bandLabel: Record<LoadBand, string> = { low: 'Low', moderate: 'Moderate', high: 'High', extreme: 'Very high' };
export const bandTone: Record<LoadBand, Tone> = { low: 'neutral', moderate: 'neutral', high: 'accent', extreme: 'danger' };
export const toneColor = (t: Tone) => (t === 'accent' ? C.accent : t === 'danger' ? C.danger : t === 'solid' ? C.text : C.text2);
