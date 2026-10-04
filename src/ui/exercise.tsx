// Exercise logbook views shared by the live workout and the exercise screen:
// best / e1RM / last session, per-session history, and a progress graph.
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Polyline } from 'react-native-svg';

import { exerciseBests, exerciseSeries, type ExerciseSession, type GraphMetric } from '@/domain/logbook';
import type { SetLog } from '@/domain/types';
import type { Units } from '@/domain/profile';
import { toUnits } from '@/domain/profile';
import { dayMonth, shortDate } from './format';
import { useUnits, wt } from './units';
import { ApexCard, Divider, EmptyState, Segmented, Txt } from './primitives';
import { C, F, S } from './theme';

export type Unit = 'reps' | 'sec' | undefined;

export const fmtSet = (s: Pick<SetLog, 'weight' | 'reps'>, unit: Unit, u: Units) => `${wt(s.weight, u)} × ${s.reps}${unit === 'sec' ? 's' : ''}`;
/** A session's sets in one short line: "12.5 × 12, 10, 8" when the weight didn't change, else each set. */
export const compactSets = (sets: Pick<SetLog, 'weight' | 'reps'>[], unit: Unit, u: Units) =>
  sets.length > 1 && sets.every((x) => x.weight === sets[0].weight)
    ? `${wt(sets[0].weight, u)} × ${sets.map((x) => `${x.reps}${unit === 'sec' ? 's' : ''}`).join(', ')}`
    : sets.map((x) => fmtSet(x, unit, u)).join(', ');
export const fmtEffort = (rir: number | undefined, scale: 'rir' | 'rpe') => (rir === undefined ? '' : scale === 'rpe' ? `RPE ${10 - rir}` : `${rir} RIR`);

/** BEST · EST. 1RM · LAST SESSION. Nothing until the exercise has been logged once. */
export function ExerciseBests({ history, unit }: { history: ExerciseSession[]; unit?: Unit }) {
  const u = useUnits();
  const b = useMemo(() => exerciseBests(history), [history]);
  if (!b) return null;
  const cells: [string, string, string][] = [
    ['Best', `${wt(b.best.set.weight, u)} ${u} × ${b.best.set.reps}${unit === 'sec' ? 's' : ''}`, dayMonth(b.best.date)],
    ...(unit === 'sec' ? [] : [['Est. 1RM', `${wt(b.e1rm.value, u)} ${u}`, dayMonth(b.e1rm.date)] as [string, string, string]]),
    ['Last session', fmtSet(b.last.set, unit, u), dayMonth(b.last.date)],
  ];
  return (
    <View style={styles.bests}>
      {cells.map(([label, value, date]) => (
        <View key={label} style={{ flex: 1, minWidth: 0 }} accessible accessibilityLabel={`${label}: ${value}, ${date}`}>
          <Txt v="overline" numberOfLines={1}>{label}</Txt>
          <Text style={styles.bestValue} numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={1.2}>{value}</Text>
          <Txt v="bodySm" color={C.text3}>{date}</Txt>
        </View>
      ))}
    </View>
  );
}

/** One block per completed session: date, sets (warm-ups marked W), effort, notes. */
export function ExerciseHistoryList({ history, unit, effortScale, onOpenSession, limit }: {
  history: ExerciseSession[]; unit?: Unit; effortScale: 'rir' | 'rpe'; onOpenSession?: (id: string) => void; limit?: number;
}) {
  const u = useUnits();
  if (!history.length) return <EmptyState title="No history yet" message="Finish a session with this exercise and every set shows up here." />;
  const shown = limit ? history.slice(0, limit) : history;
  return (
    <ApexCard padded={false}>
      {shown.map((h, i) => {
        let n = 0;
        return (
          <View key={h.instanceId}>
            {i > 0 && <Divider />}
            <Pressable onPress={onOpenSession ? () => onOpenSession(h.instanceId) : undefined} disabled={!onOpenSession} accessibilityRole={onOpenSession ? 'button' : undefined}
              accessibilityLabel={`${shortDate(h.date)}, ${h.templateName}: ${h.sets.filter((s) => s.kind === 'working').map((s) => fmtSet(s, unit, u)).join(', ')}`}
              style={({ pressed }) => [styles.session, pressed && { backgroundColor: C.pressed }]}>
              <View style={styles.sessionHead}>
                <Txt v="overline" color={C.text}>{shortDate(h.date)}</Txt>
                <Txt v="label" numberOfLines={1} style={{ flexShrink: 1 }}>
                  {h.templateName}{unit === 'sec' ? '' : ` · ${Math.round(toUnits(h.sets.filter((s) => s.kind === 'working').reduce((n, s) => n + s.weight * s.reps, 0), u)).toLocaleString('en-GB')} ${u}`}
                </Txt>
              </View>
              {h.sets.map((s) => {
                const warm = s.kind === 'warmup';
                if (!warm) n++;
                if (s.kind === 'skipped') {
                  return (
                    <View key={s.id} style={styles.line}>
                      <Text style={[styles.lineN, { color: C.text3 }]}>{n}</Text>
                      <Txt v="label" color={C.text3} style={{ flex: 1 }}>Skipped</Txt>
                    </View>
                  );
                }
                return (
                  <View key={s.id}>
                    <View style={styles.line}>
                      <Text style={[styles.lineN, warm && { color: C.text3 }]}>{warm ? 'W' : n}</Text>
                      <Text style={[styles.lineSet, warm && { color: C.text2, fontSize: 17 }]}>{fmtSet(s, unit, u)}</Text>
                      <Txt v="label" color={C.text3}>{fmtEffort(s.rir, effortScale)}</Txt>
                    </View>
                    {s.note ? <Txt v="bodySm" style={styles.setNote}>{s.note}</Txt> : null}
                  </View>
                );
              })}
              {h.notes ? <Txt v="bodySm" style={{ marginTop: 4 }}>“{h.notes}”</Txt> : null}
            </Pressable>
          </View>
        );
      })}
    </ApexCard>
  );
}

const METRIC_LABEL: Record<GraphMetric, string> = { weight: 'Weight', e1rm: 'Est. 1RM', volume: 'Volume', reps: 'Reps' };
const unitOf = (m: GraphMetric, unit: Unit, w: Units) => (m === 'reps' ? (unit === 'sec' ? 's' : 'reps') : w);
const num = (x: number) => (Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-GB') : `${+x.toFixed(1)}`);

/** Progress per session for one metric. Plain line, real values, first and last dates. */
export function ExerciseGraph({ history, unit }: { history: ExerciseSession[]; unit?: Unit }) {
  const metrics: GraphMetric[] = unit === 'sec' ? ['weight', 'reps'] : ['weight', 'e1rm', 'volume', 'reps'];
  const [metric, setMetric] = useState<GraphMetric>(unit === 'sec' ? 'weight' : 'e1rm');
  const w = useUnits();
  // values in the athlete's units (reps stay reps)
  const series = useMemo(() => exerciseSeries(history, metric).map((p) => (metric === 'reps' ? p : { ...p, value: toUnits(p.value, w) })), [history, metric, w]);
  const [width, setWidth] = useState(0);
  const u = unitOf(metric, unit, w);

  const H = 168;
  const pad = { l: 44, r: 12, t: 12, b: 24 };
  const vals = series.map((p) => p.value);
  const lo0 = Math.min(...vals);
  const hi0 = Math.max(...vals);
  const span = hi0 - lo0 || Math.max(1, hi0 * 0.1);
  const lo = Math.max(0, lo0 - span * 0.15);
  const hi = hi0 + span * 0.15;
  const x = (i: number) => pad.l + (series.length < 2 ? 0.5 : i / (series.length - 1)) * (width - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const first = series[0];
  const last = series[series.length - 1];
  const delta = series.length > 1 ? last.value - first.value : 0;

  return (
    <View>
      <Segmented label="Graph metric" options={metrics} value={metric} onChange={setMetric} format={(m) => (m === 'reps' && unit === 'sec' ? 'TIME' : METRIC_LABEL[m].toUpperCase())} height={40} />
      {!series.length ? (
        <View style={{ marginTop: S.lg }}><EmptyState title="No data yet" message="Log a few sessions to see your trend." /></View>
      ) : (
        <>
          <View style={styles.graphHead} accessible accessibilityLabel={`${METRIC_LABEL[metric]} ${num(last.value)} ${u}${series.length > 1 ? `, ${delta >= 0 ? 'up' : 'down'} ${num(Math.abs(delta))} since ${dayMonth(first.date)}` : ''}`}>
            <Text style={styles.graphNum} maxFontSizeMultiplier={1.2}>{num(last.value)}<Text style={styles.graphUnit}> {u}</Text></Text>
            <Txt v="label" color={series.length < 2 ? C.text3 : delta > 0 ? C.text : C.text2}>
              {series.length < 2 ? `One session · ${dayMonth(first.date)}. Log a few sessions to see your trend.` : `${delta === 0 ? 'No change' : `${delta > 0 ? '+' : '−'}${num(Math.abs(delta))} ${u}`} since ${dayMonth(first.date)} · ${series.length} sessions`}
            </Txt>
          </View>
          {series.length > 1 && <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ height: H, marginTop: S.md }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            {width > 0 && (
              <Svg width={width} height={H}>
                {[hi0, (hi0 + lo0) / 2, lo0].map((v, k) => (
                  <Line key={k} x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} stroke={C.line} strokeWidth={1} />
                ))}
                <Polyline points={series.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} stroke={C.text2} strokeWidth={1.75} fill="none" />
                {series.map((p, i) => (
                  <Circle key={p.instanceId} cx={x(i)} cy={y(p.value)} r={i === series.length - 1 ? 4.5 : 3} fill={i === series.length - 1 ? C.accent : C.text} />
                ))}
              </Svg>
            )}
            {width > 0 && [hi0, lo0].filter((v, k) => k === 0 || v !== hi0).map((v) => (
              <Text key={v} style={[styles.axis, { top: y(v) - 8, left: 0, width: pad.l - 6, textAlign: 'right' }]}>{num(v)}</Text>
            ))}
            {width > 0 && (
              <View style={[styles.xAxis, { left: pad.l, right: pad.r }]}>
                <Text style={styles.axisText}>{dayMonth(first.date)}</Text>
                <Text style={styles.axisText}>{dayMonth(last.date)}</Text>
              </View>
            )}
          </View>}
          <Txt v="bodySm" color={C.text3} style={{ marginTop: S.sm }}>
            {metric === 'weight' ? 'Heaviest working set per session.' : metric === 'e1rm' ? 'Best estimated one-rep max per session (Epley).' : metric === 'volume' ? 'Weight × reps across working sets.' : unit === 'sec' ? 'Total working time per session.' : 'Total working reps per session.'} Warm-ups excluded.
          </Txt>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bests: { flexDirection: 'row', gap: S.md, paddingVertical: S.md, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: C.line },
  bestValue: { fontFamily: F.display, fontSize: 20, color: C.text, fontVariant: ['tabular-nums'], marginTop: 2 },
  session: { paddingHorizontal: S.lg, paddingVertical: S.md },
  sessionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: S.md, marginBottom: 4 },
  line: { flexDirection: 'row', alignItems: 'center', minHeight: 30, gap: S.sm },
  lineN: { width: 22, fontFamily: F.display, fontSize: 15, color: C.text2, fontVariant: ['tabular-nums'] },
  lineSet: { flex: 1, fontFamily: F.display, fontSize: 20, color: C.text, fontVariant: ['tabular-nums'] },
  setNote: { marginLeft: 30, marginTop: -4, marginBottom: 4, color: C.text3 },
  graphHead: { marginTop: S.lg, gap: 2 },
  graphNum: { fontFamily: F.displayBold, fontSize: 36, lineHeight: 38, color: C.text, fontVariant: ['tabular-nums'] },
  graphUnit: { fontFamily: F.medium, fontSize: 14, color: C.text2 },
  axisText: { fontFamily: F.medium, fontSize: 11, color: C.text3, fontVariant: ['tabular-nums'] },
  axis: { position: 'absolute', fontFamily: F.medium, fontSize: 11, color: C.text3, fontVariant: ['tabular-nums'] },
  xAxis: { position: 'absolute', bottom: 0, height: 16, flexDirection: 'row', justifyContent: 'space-between' },
});
