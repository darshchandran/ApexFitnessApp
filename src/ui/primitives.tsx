import * as Haptics from 'expo-haptics';
import { useRef, useState, type ReactNode } from 'react';
import {
  Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type StyleProp, type TextProps, type TextStyle, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { PRKind } from '@/domain/types';
import { PR_LABEL } from '@/domain/records';
import { ApexMark } from './Brand';
import { Icon, type IconName } from './Icon';
import { C, F, GUTTER, R, S, TOUCH, toneColor, type Tone } from './theme';

export const tap = () => {
  if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};

// ---------- Typography ----------

const VARIANTS = StyleSheet.create({
  overline: { fontFamily: F.semibold, fontSize: 11, letterSpacing: 1.6, color: C.text3, textTransform: 'uppercase' },
  label: { fontFamily: F.medium, fontSize: 13, color: C.text2 },
  body: { fontFamily: F.regular, fontSize: 15, lineHeight: 21, color: C.text },
  bodySm: { fontFamily: F.regular, fontSize: 13, lineHeight: 18, color: C.text2 },
  title: { fontFamily: F.semibold, fontSize: 17, color: C.text },
  h1: { fontFamily: F.displayBold, fontSize: 40, lineHeight: 42, color: C.text, textTransform: 'uppercase', letterSpacing: 0.4 },
  h2: { fontFamily: F.displayBold, fontSize: 28, lineHeight: 30, color: C.text, textTransform: 'uppercase', letterSpacing: 0.3 },
  h3: { fontFamily: F.display, fontSize: 20, lineHeight: 22, color: C.text, textTransform: 'uppercase', letterSpacing: 0.4 },
  num: { fontFamily: F.display, fontSize: 24, color: C.text, fontVariant: ['tabular-nums'] },
  numL: { fontFamily: F.display, fontSize: 36, lineHeight: 38, color: C.text, fontVariant: ['tabular-nums'] },
  numXL: { fontFamily: F.displayBold, fontSize: 56, lineHeight: 58, color: C.text, fontVariant: ['tabular-nums'] },
});
export type TxtVariant = keyof typeof VARIANTS;

export function Txt({ v = 'body', color, style, ...rest }: TextProps & { v?: TxtVariant; color?: string }) {
  const big = v === 'numXL' || v === 'numL' || v === 'h1';
  return <Text maxFontSizeMultiplier={big ? 1.2 : 1.6} {...rest} style={[VARIANTS[v], color ? { color } : null, style]} />;
}

// ---------- Layout ----------

export function Screen({ children, contentStyle }: { children: ReactNode; contentStyle?: StyleProp<ViewStyle> }) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      contentContainerStyle={[{ paddingTop: insets.top + S.lg, paddingHorizontal: GUTTER, paddingBottom: S.huge }, contentStyle]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

export function ApexCard({ children, style, padded = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  return <View style={[styles.card, padded && { padding: S.lg }, style]}>{children}</View>;
}

export function SectionHeader({ title, action, onAction, style }: { title: string; action?: string; onAction?: () => void; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.section, style]}>
      <Txt v="overline" accessibilityRole="header">{title}</Txt>
      {action && (
        <Pressable onPress={onAction} hitSlop={12} accessibilityRole="button" style={styles.sectionAction}>
          <Txt v="label" color={C.text}>{action}</Txt>
        </Pressable>
      )}
    </View>
  );
}

export const Divider = ({ inset = 0 }: { inset?: number }) => <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: C.line, marginLeft: inset }} />;

// ---------- Data display ----------

export function Metric({ label, value, unit, sub, size = 'num', color }: { label: string; value: string | number; unit?: string; sub?: string; size?: 'num' | 'numL' | 'numXL'; color?: string }) {
  return (
    <View accessible accessibilityLabel={`${label}: ${value}${unit ? ` ${unit}` : ''}${sub ? `, ${sub}` : ''}`}>
      <Txt v="overline">{label}</Txt>
      <View style={styles.metricRow}>
        <Txt v={size} color={color}>{value}</Txt>
        {unit && <Txt v="label" style={{ marginLeft: 4, marginBottom: size === 'num' ? 3 : 6 }}>{unit}</Txt>}
      </View>
      {sub && <Txt v="bodySm">{sub}</Txt>}
    </View>
  );
}

export function StatusChip({ label, tone = 'neutral', style }: { label: string; tone?: Tone; style?: StyleProp<ViewStyle> }) {
  const color = toneColor(tone);
  const bg = tone === 'accent' ? C.accentSoft : tone === 'danger' ? C.dangerSoft : tone === 'solid' ? C.text : C.raised;
  return (
    <View style={[styles.chip, { backgroundColor: bg, borderColor: tone === 'neutral' ? C.line : 'transparent' }, style]}>
      <Text style={[styles.chipText, { color: tone === 'solid' ? C.bg : color }]} maxFontSizeMultiplier={1.3}>{label.toUpperCase()}</Text>
    </View>
  );
}

export function PRBadge({ kind }: { kind: PRKind }) {
  return (
    <View style={styles.pr} accessibilityLabel={PR_LABEL[kind]}>
      <Text style={styles.prText} maxFontSizeMultiplier={1.3}>{PR_LABEL[kind].toUpperCase()}</Text>
    </View>
  );
}

export function ProgressBar({ value, color = C.accent, height = 3 }: { value: number; color?: string; height?: number }) {
  return (
    <View style={{ height, backgroundColor: C.line, borderRadius: height, overflow: 'hidden' }} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}>
      <View style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, height, backgroundColor: color }} />
    </View>
  );
}

// ---------- Controls ----------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** Ignores a second press inside `ms` — stops double taps from submitting twice. */
export function useOnce(onPress: (() => void) | undefined, ms = 600) {
  const last = useRef(0);
  return () => {
    const t = Date.now();
    if (t - last.current < ms) return;
    last.current = t;
    onPress?.();
  };
}

export function Button({ label, onPress, variant = 'primary', icon, disabled, style, size = 'lg', accessibilityLabel }: {
  label: string; onPress?: () => void; variant?: ButtonVariant; icon?: IconName; disabled?: boolean; style?: StyleProp<ViewStyle>; size?: 'lg' | 'md'; accessibilityLabel?: string;
}) {
  const press = useOnce(onPress);
  const off = disabled && variant === 'primary';
  const fg = off ? C.text3 : variant === 'primary' ? C.onAccent : variant === 'danger' ? C.danger : C.text;
  return (
    <Pressable
      onPress={() => { tap(); press(); }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.button,
        size === 'md' && { height: TOUCH, paddingHorizontal: S.lg },
        variant === 'primary' && { backgroundColor: off ? C.raised : C.accent },
        variant === 'secondary' && { backgroundColor: C.raised, borderWidth: 1, borderColor: C.lineStrong },
        variant === 'danger' && { borderWidth: 1, borderColor: C.danger },
        pressed && { opacity: 0.82, transform: [{ scale: 0.985 }] },
        disabled && !off && { opacity: 0.4 },
        style,
      ]}
    >
      {icon && <Icon name={icon} size={20} color={fg} strokeWidth={2} />}
      <Text style={[styles.buttonText, { color: fg }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{label.toUpperCase()}</Text>
    </Pressable>
  );
}

export function IconButton({ icon, onPress, label, color = C.text, style, size = TOUCH, filled }: {
  icon: IconName; onPress?: () => void; label: string; color?: string; style?: StyleProp<ViewStyle>; size?: number; filled?: boolean;
}) {
  const press = useOnce(onPress, 400);
  return (
    <Pressable
      onPress={() => { tap(); press(); }}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={({ pressed }) => [
        { width: size, height: size, borderRadius: R.md, alignItems: 'center', justifyContent: 'center' },
        filled && { backgroundColor: C.raised, borderWidth: 1, borderColor: C.line },
        pressed && { backgroundColor: C.pressed },
        style,
      ]}
    >
      <Icon name={icon} color={color} />
    </Pressable>
  );
}

const parseNumber = (t: string) => {
  const n = Number(t.replace(',', '.'));
  return t.trim() !== '' && Number.isFinite(n) ? n : NaN;
};

/**
 * Big −/value/+ control. Tap the value to type it. Typed values are committed as soon as
 * they're valid, so tapping LOG SET with the keyboard still open uses what's on screen.
 */
export function Stepper({ label, value, step, onChange, min = 0, max = 9999, unit, integer = false, format = (n: number) => String(+n.toFixed(2)), width }: {
  label: string; value: number; step: number; onChange: (n: number) => void; min?: number; max?: number; unit?: string;
  integer?: boolean; format?: (n: number) => string; width?: number | `${number}%`;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(max, Math.max(min, +n.toFixed(2)));
  const set = (n: number) => onChange(clamp(n));
  const finish = () => {
    if (editing !== null) {
      const n = parseNumber(editing);
      if (!Number.isNaN(n)) set(integer ? Math.round(n) : n); // out-of-range snaps to the limit; junk keeps the last value
    }
    setEditing(null);
  };
  return (
    <View style={{ flex: width ? undefined : 1, width }}>
      <Txt v="overline" style={{ marginBottom: S.sm }}>{label}{unit ? ` · ${unit}` : ''}</Txt>
      <View style={styles.stepper}>
        <Pressable onPress={() => { tap(); set(value - step); }} disabled={value <= min} style={({ pressed }) => [styles.stepBtn, pressed && { backgroundColor: C.pressed }, value <= min && { opacity: 0.35 }]} accessibilityRole="button" accessibilityLabel={`Decrease ${label}`}>
          <Icon name="minus" size={22} />
        </Pressable>
        {editing !== null ? (
          <TextInput
            autoFocus
            value={editing}
            onChangeText={(t) => {
              const clean = integer ? t.replace(/[^0-9]/g, '') : t.replace(/[^0-9.,]/g, '');
              setEditing(clean);
              const n = parseNumber(clean);
              if (!Number.isNaN(n) && n >= min && n <= max) onChange(+n.toFixed(2));
            }}
            onBlur={finish}
            onSubmitEditing={finish}
            keyboardType={integer ? 'number-pad' : 'decimal-pad'}
            returnKeyType="done"
            maxLength={6}
            selectTextOnFocus
            style={[styles.stepValue, styles.stepInput]}
            accessibilityLabel={label}
          />
        ) : (
          <Pressable style={styles.stepValueWrap} onPress={() => setEditing(String(value))} accessibilityRole="adjustable" accessibilityLabel={`${label} ${format(value)}${unit ? ` ${unit}` : ''}`} accessibilityHint="Tap to type a value"
            accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
            onAccessibilityAction={(e) => set(value + (e.nativeEvent.actionName === 'increment' ? step : -step))}>
            <Text style={styles.stepValue} maxFontSizeMultiplier={1.2}>{format(value)}</Text>
          </Pressable>
        )}
        <Pressable onPress={() => { tap(); set(value + step); }} disabled={value >= max} style={({ pressed }) => [styles.stepBtn, pressed && { backgroundColor: C.pressed }, value >= max && { opacity: 0.35 }]} accessibilityRole="button" accessibilityLabel={`Increase ${label}`}>
          <Icon name="plus" size={22} />
        </Pressable>
      </View>
    </View>
  );
}

/** Single-select row of large options. */
export function Segmented<T extends string | number>({ options, value, onChange, label, format = String, height = TOUCH, columns }: {
  options: readonly T[]; value: T | undefined; onChange: (v: T) => void; label?: string; format?: (v: T) => string; height?: number; columns?: number;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label}>
      <View style={[styles.segRow, columns ? { flexWrap: 'wrap' } : null]}>
        {options.map((o) => {
          const on = o === value;
          return (
            <Pressable
              key={String(o)}
              onPress={() => { tap(); onChange(o); }}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${label ? `${label} ` : ''}${format(o)}`}
              style={({ pressed }) => [
                styles.seg,
                { height },
                columns ? { flexBasis: `${100 / columns - 2}%`, flexGrow: 1 } : { flex: 1 },
                on && { backgroundColor: C.text, borderColor: C.text },
                pressed && !on && { backgroundColor: C.pressed },
              ]}
            >
              <Text style={[styles.segText, on && { color: C.bg }]} maxFontSizeMultiplier={1.3}>{format(o)}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Toggleable option chip (multi-option rows where none may be selected). */
export function Chip({ label, selected, onPress, style }: { label: string; selected: boolean; onPress: () => void; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable onPress={() => { tap(); onPress(); }} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} accessibilityLabel={label}
      style={({ pressed }) => [styles.seg, { height: TOUCH }, selected && { backgroundColor: C.text, borderColor: C.text }, pressed && !selected && { backgroundColor: C.pressed }, style]}>
      <Text style={[styles.segText, selected && { color: C.bg }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{label}</Text>
    </Pressable>
  );
}

export function ListRow({ title, subtitle, right, onPress, left, accessibilityLabel }: {
  title: string; subtitle?: string; right?: ReactNode; onPress?: () => void; left?: ReactNode; accessibilityLabel?: string;
}) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.listRow, pressed && { backgroundColor: C.pressed }]}>
      {left}
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="title" numberOfLines={1}>{title}</Txt>
        {subtitle && <Txt v="bodySm" numberOfLines={2}>{subtitle}</Txt>}
      </View>
      {right}
      {onPress && <Icon name="chevron-right" size={18} color={C.text3} />}
    </Pressable>
  );
}

export function EmptyState({ title, message, action, onAction, icon, mark }: { title: string; message: string; action?: string; onAction?: () => void; icon?: IconName; mark?: boolean }) {
  return (
    <View style={styles.empty}>
      {mark && <View style={{ marginBottom: S.xs, opacity: 0.7 }}><ApexMark size={18} variant="light" /></View>}
      {icon && <View style={styles.emptyIcon}><Icon name={icon} size={20} color={C.text2} /></View>}
      <Txt v="overline" color={C.text2}>{title}</Txt>
      <Txt v="body" color={C.text2} style={{ textAlign: 'center', maxWidth: 280 }}>{message}</Txt>
      {action && <Button label={action} variant="secondary" size="md" onPress={onAction} style={{ marginTop: S.sm, alignSelf: 'center' }} />}
    </View>
  );
}

export const styles = StyleSheet.create({
  card: { backgroundColor: C.surface, borderRadius: R.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line },
  section: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: S.xxxl, marginBottom: S.md, minHeight: 24 },
  sectionAction: { minHeight: 32, justifyContent: 'center', paddingHorizontal: S.xs },
  metricRow: { flexDirection: 'row', alignItems: 'flex-end', marginTop: 2 },
  chip: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth },
  chipText: { fontFamily: F.semibold, fontSize: 10.5, letterSpacing: 1.1 } as TextStyle,
  pr: { alignSelf: 'flex-start', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 4, borderWidth: 1, borderColor: C.accent },
  prText: { fontFamily: F.semibold, fontSize: 9.5, letterSpacing: 1.1, color: C.accent },
  button: { height: 56, borderRadius: R.md, paddingHorizontal: S.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm },
  buttonText: { fontFamily: F.semibold, fontSize: 13.5, letterSpacing: 0.9, flexShrink: 1 },
  stepper: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.raised, borderRadius: R.md, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line, height: 60 },
  stepBtn: { width: 52, height: 60, alignItems: 'center', justifyContent: 'center', borderRadius: R.md },
  stepValueWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', height: 60 },
  stepValue: { fontFamily: F.display, fontSize: 32, color: C.text, textAlign: 'center', fontVariant: ['tabular-nums'] },
  stepInput: { flex: 1, height: 60, padding: 0, outlineWidth: 0 },
  segRow: { flexDirection: 'row', gap: 6 },
  seg: { borderRadius: R.sm, backgroundColor: C.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  segText: { fontFamily: F.semibold, fontSize: 14, color: C.text, letterSpacing: 0.3 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingVertical: S.md, paddingHorizontal: S.lg, minHeight: 60 },
  empty: { alignItems: 'center', gap: S.sm, paddingVertical: S.xxl, paddingHorizontal: S.lg, borderRadius: R.lg, borderWidth: 1, borderColor: C.line, borderStyle: 'dashed' },
  emptyIcon: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center', marginBottom: S.xs },
});
