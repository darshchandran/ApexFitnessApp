import { useState, type ReactNode } from 'react';
import { LayoutAnimation, Platform, Pressable, StyleSheet, Text, UIManager, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { gymExercise, plyoExercise } from '@/domain/catalog';
import type { Units } from '@/domain/profile';
import type { AdaptationDecision, BasketballSession, DailyLoad, SessionInstance, Template } from '@/domain/types';
import { basketballLoad, templateContacts } from '@/domain/load';
import { workingSetCount } from '@/domain/templates';
import { weekdayIndex } from '@/domain/util';
import { Icon, type IconName } from './Icon';
import { ApexCard, Button, Divider, Segmented, StatusChip, Txt } from './primitives';
import { repRange, shortDate, pad2, sessionSummary } from './format';
import { bandLabel, bandTone, C, F, R, S } from './theme';

if (Platform.OS === 'android') UIManager.setLayoutAnimationEnabledExperimental?.(true);
export const animateLayout = () => LayoutAnimation.configureNext(LayoutAnimation.create(200, 'easeInEaseOut', 'opacity'));

// ---------- ProgressRing ----------

export function ProgressRing({ size = 88, stroke = 6, value, color = C.accent, children, label }: {
  size?: number; stroke?: number; value: number; color?: string; children?: ReactNode; label: string;
}) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <View style={{ width: size, height: size }} accessible accessibilityLabel={label}>
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={C.line} strokeWidth={stroke} fill="none" />
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none"
          strokeDasharray={`${circ} ${circ}`} strokeDashoffset={circ * (1 - v)} strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </Svg>
      <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>{children}</View>
    </View>
  );
}

// ---------- Adaptation explanation ----------

/**
 * What Apex changed and why — plus the athlete's choice. Controls appear only for an
 * unstarted session Apex actually changed: ADAPT (recommended) or KEEP PLAN, an alternative
 * template when one is suggested, and a recovery day.
 */
export function AdaptationNote({ decision, plan = 'adapted', controls, onPlanMode, onAlternative, alternativeName, onRecovery }: {
  decision: AdaptationDecision;
  plan?: 'adapted' | 'kept';
  controls?: boolean;
  onPlanMode?: (p: 'adapted' | 'kept') => void;
  onAlternative?: () => void;
  alternativeName?: string;
  onRecovery?: () => void;
}) {
  const changed = decision.outcome !== 'normal';
  const kept = plan === 'kept';
  const accent = !changed || kept ? C.lineStrong : decision.outcome === 'alternative' || decision.outcome === 'deferred' ? C.danger : C.accent;
  return (
    <View style={[styles.note, { borderLeftColor: accent }]}>
      <Txt v="overline" color={changed ? C.text2 : C.text3}>{kept ? 'Your plan' : 'Why'}</Txt>
      <Txt v="title" style={{ marginTop: 2 }}>{kept ? 'Training the template as written' : decision.headline}</Txt>
      {kept && <Txt v="bodySm" style={{ marginTop: 4 }}>Apex recommended: {decision.headline.charAt(0).toLowerCase() + decision.headline.slice(1)}.</Txt>}
      <View style={{ gap: 6, marginTop: S.sm }}>
        {decision.reasons.map((r) => (
          <View key={r} style={styles.reason}>
            <View style={styles.dot} />
            <Txt v="bodySm" style={{ flex: 1 }}>{r}</Txt>
          </View>
        ))}
      </View>
      {controls && changed && onPlanMode && (
        <View style={{ marginTop: S.md }}>
          <Segmented label="Session plan" options={['adapted', 'kept'] as const} value={plan} onChange={onPlanMode}
            format={(v) => (v === 'adapted' ? 'ADAPT' : 'KEEP PLAN')} height={44} />
        </View>
      )}
      {controls && (onAlternative && alternativeName || onRecovery) && changed && (
        <View style={styles.noteActions}>
          {onAlternative && alternativeName && (
            <Button label={`Train ${alternativeName}`} variant="secondary" size="md" icon="swap" onPress={onAlternative} style={{ flexGrow: 1 }} />
          )}
          {onRecovery && <Button label="Recovery day" variant="secondary" size="md" onPress={onRecovery} style={{ flexGrow: 1 }} />}
        </View>
      )}
    </View>
  );
}

// ---------- Template card ----------

function focusOf(t: Template) {
  if (t.kind === 'plyometric') {
    const cats = new Map<string, number>();
    for (const e of t.exercises) for (const c of plyoExercise(e.exerciseId).categories) cats.set(c, (cats.get(c) ?? 0) + e.sets);
    return [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c.toUpperCase()).join(' · ');
  }
  const total = workingSetCount(t);
  const lower = t.exercises.filter((e) => gymExercise(e.exerciseId).region === 'lower').reduce((n, e) => n + e.sets, 0);
  if (!total) return 'EMPTY';
  const share = lower / total;
  return share >= 0.6 ? 'LOWER BODY' : share <= 0.2 ? 'UPPER BODY' : 'FULL BODY';
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <View>
      <Text style={styles.statNum} maxFontSizeMultiplier={1.2}>{pad2(n)}</Text>
      <Txt v="overline">{label}</Txt>
    </View>
  );
}

export function TemplateCard({ template: t, onPress, badge }: { template: Template; onPress: () => void; badge?: string }) {
  const second = t.kind === 'gym' ? { n: workingSetCount(t), label: 'Working sets' } : { n: templateContacts(t), label: 'Contacts' };
  return (
    <Pressable onPress={onPress} accessibilityRole="button"
      accessibilityLabel={`${t.name}. ${t.exercises.length} exercises, ${second.n} ${second.label}. ${t.tag}.${badge ? ` ${badge}.` : ''}`}
      style={({ pressed }) => [styles.tcard, pressed && { backgroundColor: C.raised }]}>
      <View style={styles.tHead}>
        <Txt v="h2" numberOfLines={1} style={{ flex: 1 }}>{t.name}</Txt>
        {badge && <StatusChip label={badge} tone="accent" />}
      </View>
      <View style={styles.tStats}>
        <Stat n={t.exercises.length} label="Exercises" />
        <Stat n={second.n} label={second.label} />
      </View>
      <Divider />
      <View style={styles.tFoot}>
        <View style={styles.tagMark} />
        <Txt v="overline" color={C.text} numberOfLines={1}>{t.tag}</Txt>
        <Txt v="overline" style={{ marginHorizontal: 6 }}>·</Txt>
        <Txt v="overline" numberOfLines={1} style={{ flex: 1 }}>{focusOf(t)}</Txt>
        <Icon name="chevron-right" size={18} color={C.text3} />
      </View>
    </Pressable>
  );
}

// ---------- Training load ----------

export const readinessWord = (r: number) => (r >= 80 ? 'Primed' : r >= 65 ? 'Good' : r >= 50 ? 'Moderate' : r >= 35 ? 'Low' : 'Very low');

export function TrainingLoadCard({ readiness, load, week, bands, onCheckIn }: {
  readiness?: number; load: DailyLoad; week: DailyLoad[]; bands: AdaptationDecision['bands']; onCheckIn: () => void;
}) {
  const max = Math.max(650, ...week.map((d) => d.total));
  const parts: [string, number][] = [['Basketball', load.basketball], ['Gym', load.gym], ['Plyo', load.plyo]];
  return (
    <ApexCard padded={false}>
      <View style={styles.loadTop}>
        <ProgressRing value={(readiness ?? 0) / 100} label={readiness === undefined ? 'Readiness not checked in' : `Readiness ${readiness} of 100`} color={C.text}>
          <Text style={styles.ringNum} maxFontSizeMultiplier={1.2}>{readiness ?? '—'}</Text>
        </ProgressRing>
        <View style={{ flex: 1, gap: S.md }}>
          <View>
            <Txt v="overline">Readiness</Txt>
            {readiness === undefined ? (
              <Pressable onPress={onCheckIn} accessibilityRole="button" hitSlop={8} style={styles.checkIn}>
                <Txt v="title">Check in</Txt>
                <Icon name="chevron-right" size={18} color={C.text2} />
              </Pressable>
            ) : (
              <Pressable onPress={onCheckIn} accessibilityRole="button" accessibilityLabel={`Readiness ${readinessWord(readiness)}. Update check-in`} hitSlop={8}>
                <Txt v="title">{readinessWord(readiness)}</Txt>
              </Pressable>
            )}
          </View>
          <View>
            <Txt v="overline">Load today</Txt>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
              <Txt v="title" color={bandTone[load.band] === 'neutral' ? C.text : bandTone[load.band] === 'accent' ? C.accent : C.danger}>{bandLabel[load.band]}</Txt>
              <Txt v="label">{load.total}</Txt>
            </View>
          </View>
        </View>
      </View>
      <Divider />
      <View style={styles.loadParts}>
        {parts.map(([label, v]) => (
          <View key={label} style={{ flex: 1 }}>
            <Txt v="overline">{label}</Txt>
            <Txt v="num" color={v ? C.text : C.text3}>{v}</Txt>
          </View>
        ))}
      </View>
      <Divider />
      <View style={styles.regionRow}>
        <RegionChip label="Lower body" band={bands.lower} />
        <RegionChip label="Upper body" band={bands.upper} />
        <RegionChip label="Jumps" band={bands.jump} />
      </View>
      <Divider />
      <View style={styles.week} accessible accessibilityLabel={`Seven-day load: ${week.map((d) => d.total).join(', ')}`}>
        {week.map((d, i) => {
          const today = i === week.length - 1;
          return (
            <View key={d.date} style={styles.weekCol}>
              <View style={styles.weekTrack}>
                <View style={{ height: `${Math.max(3, (d.total / max) * 100)}%`, backgroundColor: today ? C.accent : d.total ? C.text2 : C.line, borderRadius: 2 }} />
              </View>
              <Txt v="overline" color={today ? C.text : C.text3} style={{ letterSpacing: 0.5 }}>{'MTWTFSS'[weekdayIndex(d.date)]}</Txt>
            </View>
          );
        })}
      </View>
    </ApexCard>
  );
}

function RegionChip({ label, band }: { label: string; band: AdaptationDecision['bands']['lower'] }) {
  return (
    <View style={{ flex: 1, gap: 4 }}>
      <Txt v="overline" numberOfLines={1}>{label}</Txt>
      <StatusChip label={bandLabel[band]} tone={bandTone[band]} />
    </View>
  );
}

// ---------- Prescription rows ----------

export function PrescriptionRow({ index, instance, exercise }: { index: number; instance: SessionInstance; exercise: SessionInstance['exercises'][number] }) {
  const removed = exercise.status === 'removed';
  let rx: string;
  let programmed: number;
  if (instance.kind === 'gym') {
    const e = exercise as Extract<SessionInstance, { kind: 'gym' }>['exercises'][number];
    rx = `${e.prescribed.sets} × ${repRange(e.prescribed.repRange, gymExercise(e.exerciseId).unit)}`;
    programmed = e.templateSets;
  } else {
    const e = exercise as Extract<SessionInstance, { kind: 'plyometric' }>['exercises'][number];
    rx = `${e.prescribed.sets} × ${e.prescribed.reps}${e.prescribed.perSide ? '/side' : ''}`;
    programmed = e.template?.sets ?? e.prescribed.sets;
  }
  const changed = !removed && programmed > 0 && programmed !== exercise.prescribed.sets;
  return (
    <View style={styles.rxRow} accessible accessibilityLabel={`${exercise.name}: ${removed ? 'removed today' : rx}${changed ? `, reduced from ${programmed} sets` : ''}`}>
      <Text style={[styles.rxIndex, removed && { color: C.text3 }]}>{pad2(index + 1)}</Text>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="body" color={removed ? C.text3 : C.text} style={removed && styles.strike} numberOfLines={2}>{exercise.name}</Txt>
        {changed && <Txt v="bodySm" color={C.accent}>{programmed} → {exercise.prescribed.sets} {exercise.prescribed.sets === 1 ? 'set' : 'sets'}</Txt>}
        {exercise.substitutedFrom && <Txt v="bodySm">Swapped from {exercise.substitutedFrom}</Txt>}
      </View>
      {removed ? <StatusChip label="Removed" /> : <Txt v="label" color={C.text}>{rx}</Txt>}
    </View>
  );
}

// ---------- Session rows (history) ----------

export function SessionRow({ icon, title, subtitle, date, onPress, right }: { icon: IconName; title: string; subtitle: string; date?: string; onPress?: () => void; right?: ReactNode }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole="button" accessibilityLabel={`${title}, ${subtitle}${date ? `, ${date}` : ''}`}
      style={({ pressed }) => [styles.sRow, pressed && { backgroundColor: C.pressed }]}>
      <View style={styles.sIcon}><Icon name={icon} size={18} color={C.text2} /></View>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="title" numberOfLines={1}>{title}</Txt>
        <Txt v="bodySm" numberOfLines={1}>{subtitle}</Txt>
      </View>
      {right}
      {date && <Txt v="label">{date}</Txt>}
    </Pressable>
  );
}

export const instanceRowProps = (i: SessionInstance, u: Units) => ({
  icon: (i.kind === 'gym' ? 'train' : 'bolt') as IconName,
  title: i.templateName,
  subtitle: sessionSummary(i, u),
  date: shortDate(i.date),
});

export const basketballRowProps = (b: BasketballSession) => ({
  icon: 'ball' as IconName,
  title: 'Basketball',
  subtitle: `${b.durationMin} min · RPE ${b.rpe} · load ${Math.round(basketballLoad(b).total)}`,
  date: shortDate(b.date),
});

export function Expandable({ title, children, initiallyOpen = false }: { title: string; children: ReactNode; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View>
      <Pressable onPress={() => { animateLayout(); setOpen(!open); }} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.expHead}>
        <Txt v="label" color={C.text}>{title}</Txt>
        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Icon name="chevron-down" size={18} color={C.text2} /></View>
      </Pressable>
      {open && children}
    </View>
  );
}

const styles = StyleSheet.create({
  note: { borderLeftWidth: 2, borderLeftColor: C.lineStrong, paddingLeft: S.md, paddingVertical: 2 },
  reason: { flexDirection: 'row', gap: S.sm, alignItems: 'flex-start' },
  noteActions: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm, marginTop: S.sm },
  dot: { width: 4, height: 4, borderRadius: 1, backgroundColor: C.text3, marginTop: 7 },
  tcard: { backgroundColor: C.surface, borderRadius: R.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line, paddingHorizontal: S.lg, paddingTop: S.lg },
  tHead: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  tStats: { flexDirection: 'row', gap: S.xxxl, marginTop: S.md, marginBottom: S.lg },
  statNum: { fontFamily: F.display, fontSize: 30, lineHeight: 32, color: C.text, fontVariant: ['tabular-nums'] },
  tFoot: { flexDirection: 'row', alignItems: 'center', minHeight: 48 },
  tagMark: { width: 3, height: 12, backgroundColor: C.accent, marginRight: S.sm, borderRadius: 1 },
  loadTop: { flexDirection: 'row', alignItems: 'center', gap: S.xl, padding: S.lg },
  ringNum: { fontFamily: F.displayBold, fontSize: 30, color: C.text, fontVariant: ['tabular-nums'] },
  checkIn: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 32 },
  loadParts: { flexDirection: 'row', paddingHorizontal: S.lg, paddingVertical: S.md },
  regionRow: { flexDirection: 'row', gap: S.sm, paddingHorizontal: S.lg, paddingVertical: S.md },
  week: { flexDirection: 'row', gap: S.sm, paddingHorizontal: S.lg, paddingTop: S.md, paddingBottom: S.md, height: 92 },
  weekCol: { flex: 1, alignItems: 'center', gap: 6 },
  weekTrack: { flex: 1, width: '100%', maxWidth: 18, justifyContent: 'flex-end' },
  rxRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingVertical: S.md, minHeight: 52 },
  rxIndex: { fontFamily: F.display, fontSize: 16, color: C.text2, width: 22, fontVariant: ['tabular-nums'] },
  strike: { textDecorationLine: 'line-through' },
  sRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingVertical: S.md, paddingHorizontal: S.lg, minHeight: 64 },
  sIcon: { width: 36, height: 36, borderRadius: R.sm, backgroundColor: C.raised, alignItems: 'center', justifyContent: 'center' },
  expHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
});
