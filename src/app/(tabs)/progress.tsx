import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';

import { GROUP_LABEL } from '@/domain/areas';
import { plyoBests, strengthTrend, trainedExercises } from '@/domain/history';
import { plyoLoad } from '@/domain/load';
import { headlinePRs } from '@/domain/records';
import type { BodyMetricKind, PerformanceKind, PersonalRecord } from '@/domain/types';
import { addDays } from '@/domain/util';
import { progressOverview } from '@/services/apex';
import { apex, useApex } from '@/services/useApex';
import { BottomSheet } from '@/ui/BottomSheet';
import { shortDate } from '@/ui/format';
import { localize, useUnits, wt } from '@/ui/units';
import { ContextPrompt } from '@/ui/context';
import { fromUnits, toUnits } from '@/domain/profile';
import { go } from '@/ui/nav';
import { ApexCard, Button, Chip, Divider, EmptyState, Metric, PRBadge, Screen, SectionHeader, Segmented, StatusChip, Stepper, Txt } from '@/ui/primitives';
import { SessionRow, basketballRowProps, instanceRowProps } from '@/ui/training';
import { bandLabel, bandTone, C, F, S } from '@/ui/theme';
import type { Trend } from '@/domain/strain';

const ATHLETIC: { kind: PerformanceKind; label: string; from: string[] }[] = [
  { kind: 'vertical', label: 'Vertical', from: ['cmj'] },
  { kind: 'approach', label: 'Approach', from: ['approach-jump', 'two-leg-max-jump'] },
  { kind: 'broad', label: 'Broad', from: ['broad-jump', 'standing-broad-jump'] },
];
const REGION_LABEL: Record<string, string> = { lower: 'Lower body', upper: 'Upper body', trunk: 'Core', jump: 'Jumping' };
const TREND_ARROW: Record<Trend, string> = { up: '↑', flat: '→', down: '↓' };
const TREND_WORD: Record<Trend, string> = { up: 'Increasing', flat: 'Stable', down: 'Decreasing' };
const round10 = (x: number) => Math.round(x / 10) * 10;

const BODY: { kind: BodyMetricKind; label: string; unit: string }[] = [
  { kind: 'bodyweight', label: 'Bodyweight', unit: 'kg' },
  { kind: 'waist', label: 'Waist', unit: 'cm' },
  { kind: 'chest', label: 'Chest', unit: 'cm' },
  { kind: 'arm', label: 'Arm', unit: 'cm' },
  { kind: 'thigh', label: 'Thigh', unit: 'cm' },
];

function Sparkline({ values, width = 120, height = 36 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (width - 6) + 3, height - 3 - ((v - lo) / (hi - lo || 1)) * (height - 6)]);
  const last = pts[pts.length - 1];
  return (
    <Svg width={width} height={height}>
      <Polyline points={pts.map((p) => p.join(',')).join(' ')} stroke={C.text2} strokeWidth={1.5} fill="none" />
      <Circle cx={last[0]} cy={last[1]} r={3} fill={C.accent} />
    </Svg>
  );
}

export default function Progress() {
  const { data } = useApex();
  const u = useUnits();
  const date = apex.today();
  const [tab, setTab] = useState<'overview' | 'history'>('overview');
  const [sheet, setSheet] = useState<'test' | 'body' | null>(null);

  const recentPRs = useMemo(() => {
    const byInstance = new Map<string, PersonalRecord[]>();
    for (const r of data.records) byInstance.set(r.instanceId, [...(byInstance.get(r.instanceId) ?? []), r]);
    return [...byInstance.values()].flatMap(headlinePRs).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  }, [data.records]);
  const lifts = useMemo(() => trainedExercises(data.instances), [data.instances]);
  const [liftId, setLiftId] = useState<string | undefined>();
  const lift = liftId ?? lifts[0]?.id;
  const trend = useMemo(() => (lift ? strengthTrend(data.instances, lift) : []), [data.instances, lift]);
  const ov = useMemo(() => progressOverview(data, date), [data, date]);
  const bests = useMemo(() => plyoBests(data.instances), [data.instances]);
  const weekContacts = useMemo(() => data.instances
    .filter((i) => i.kind === 'plyometric' && i.status === 'completed' && i.date > addDays(date, -7))
    .reduce((n, i) => n + (i.kind === 'plyometric' ? plyoLoad(i).contacts : 0), 0), [data.instances, date]);
  const athletic = ATHLETIC.map((a) => {
    const tests = data.performance.filter((p) => p.kind === a.kind).map((p) => p.value);
    const fromPlyo = bests.filter((b) => a.from.includes(b.id)).map((b) => b.value);
    const all = [...tests, ...fromPlyo];
    return { ...a, best: all.length ? Math.max(...all) : undefined };
  });
  const latestBody = (kind: BodyMetricKind) => data.bodyMetrics.filter((m) => m.kind === kind).sort((a, b) => a.date.localeCompare(b.date));

  const history = useMemo(() => [
    ...data.instances.filter((i) => i.status === 'completed').map((i) => ({ at: i.completedAt ?? i.date, date: i.date, id: i.id, row: instanceRowProps(i, u) })),
    ...data.basketball.map((b) => ({ at: b.loggedAt, date: b.date, id: b.id, row: basketballRowProps(b) })),
  ].sort((a, b) => b.at.localeCompare(a.at)), [data.instances, data.basketball, u]);

  const volumeScale = Math.max(24, ...ov.volume.map((m) => m.sets));
  // what the athlete is improving (else their goal) decides what comes first: jump work or muscle volume
  const f = data.profile.focus;
  const jumpFirst = f ? f === 'jump' || f === 'speed' : data.profile.goal === 'performance';
  const jump = (
    <>
      <SectionHeader title="Jump performance" />
      <ApexCard>
        <Metric label="Contacts · last 7 days" value={weekContacts} size="numL" />
        {bests.length > 0 && <Divider />}
        {bests.map((b) => (
          <View key={b.id} style={styles.kv}>
            <Txt v="body">{b.name}</Txt>
            <Txt v="num">{b.value}<Txt v="label"> cm</Txt></Txt>
          </View>
        ))}
      </ApexCard>
    </>
  );

  return (
    <Screen>
      <Txt v="overline">Progress</Txt>
      <Txt v="h2" style={{ marginTop: 2, marginBottom: S.lg }} accessibilityRole="header">Performance</Txt>
      <Segmented label="Progress view" options={['overview', 'history'] as const} value={tab} onChange={setTab} format={(v) => v.toUpperCase()} />

      {tab === 'history' ? (
        <View style={{ marginTop: S.xl }}>
          {history.length === 0 ? (
            <EmptyState mark title="No workout history" message="Your training history starts here." action="Start a session" onAction={go.train} />
          ) : (
            history.map((h, i) => (
              <View key={h.id}>
                {(i === 0 || history[i - 1].date !== h.date) && <Txt v="overline" style={{ marginTop: i ? S.xl : 0, marginBottom: S.sm }}>{shortDate(h.date)}</Txt>}
                <ApexCard padded={false} style={{ marginBottom: S.sm }}>
                  <SessionRow {...h.row} date={undefined} onPress={() => go.session(h.id)} />
                </ApexCard>
              </View>
            ))
          )}
        </View>
      ) : (
        <>
          {ov.insights.length > 0 && (
            <>
              <SectionHeader title="This week" />
              <ApexCard padded={false}>
                {ov.insights.map((ins, i) => (
                  <View key={ins.id}>
                    {i > 0 && <Divider />}
                    <View style={styles.insight}>
                      <View style={[styles.insightMark, ins.tone === 'attention' && { backgroundColor: C.accent }, ins.tone === 'positive' && { backgroundColor: C.text }]} />
                      <Txt v="body" style={{ flex: 1 }}>{ins.text}</Txt>
                    </View>
                  </View>
                ))}
              </ApexCard>
            </>
          )}

          <SectionHeader title="Training load · 7 days" />
          <ApexCard padded={false}>
            {ov.regions.map((r, i) => (
              <View key={r.area}>
                {i > 0 && <Divider />}
                <View style={styles.loadRow} accessible accessibilityLabel={`${REGION_LABEL[r.area]}: ${bandLabel[r.accumulated]}, ${ov.historyDays >= 8 ? TREND_WORD[r.trend] : 'first week'}. ${round10(r.acute7)} this week, usual ${round10(r.baseline)}.`}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Txt v="title">{REGION_LABEL[r.area]}</Txt>
                    <Txt v="bodySm" numberOfLines={1}>{round10(r.acute7).toLocaleString('en-GB')} vs {ov.historyDays >= 14 ? 'usual' : 'typical'} {round10(r.baseline).toLocaleString('en-GB')}</Txt>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 4 }}>
                    <StatusChip label={bandLabel[r.accumulated]} tone={bandTone[r.accumulated]} />
                    <Txt v="label" color={r.trend === 'up' && ov.historyDays >= 8 ? C.text : C.text2}>{ov.historyDays >= 8 ? `${TREND_ARROW[r.trend]} ${TREND_WORD[r.trend]}` : 'First week'}</Txt>
                  </View>
                </View>
              </View>
            ))}
          </ApexCard>
          <Txt v="bodySm" style={styles.footnote}>Internal training-load estimate compared with {ov.historyDays >= 14 ? 'your usual week' : 'a typical week until you have two weeks of history'}. Not a medical measure.</Txt>

          {jumpFirst && jump}

          <SectionHeader title="Muscle volume · 7 days" />
          <ApexCard>
            {ov.volume.map((m) => (
              <View key={m.group} style={styles.barRow} accessible accessibilityLabel={`${GROUP_LABEL[m.group]}: ${m.sets} sets, target ${m.target[0]} to ${m.target[1]}, ${m.status}`}>
                <Txt v="label" color={C.text} style={{ width: 82 }} numberOfLines={1}>{GROUP_LABEL[m.group]}</Txt>
                <View style={styles.track}>
                  <View style={[styles.zone, { left: `${(m.target[0] / volumeScale) * 100}%`, width: `${((m.target[1] - m.target[0]) / volumeScale) * 100}%` }]} />
                  <View style={[styles.fill, { width: `${Math.min(1, m.sets / volumeScale) * 100}%`, backgroundColor: m.status === 'high' ? C.accent : m.status === 'in range' ? C.text : C.text3 }]} />
                </View>
                <Txt v="label" color={C.text} style={styles.barNum}>{m.sets}</Txt>
                <Txt v="overline" color={m.status === 'high' ? C.accent : m.status === 'in range' ? C.text : C.text3} style={{ width: 62, textAlign: 'right' }}>{m.status === 'in range' ? 'In range' : m.status}</Txt>
              </View>
            ))}
            <Txt v="bodySm" style={{ marginTop: S.sm }}>Working sets; secondary muscles count half. Shaded band = weekly target.</Txt>
          </ApexCard>

          <SectionHeader title="Personal records" />
          {recentPRs.length ? (
            <ApexCard padded={false}>
              {recentPRs.map((pr, i) => (
                <View key={pr.id}>
                  {i > 0 && <Divider />}
                  <View style={styles.prRow}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Txt v="title" numberOfLines={1}>{pr.exerciseName}</Txt>
                      <Txt v="bodySm">{localize(pr.detail, u)} · {shortDate(pr.date)}</Txt>
                    </View>
                    <PRBadge kind={pr.kind} />
                  </View>
                </View>
              ))}
            </ApexCard>
          ) : (
            <EmptyState title="No PRs yet" message="Your first PR starts with your first session." />
          )}

          <SectionHeader title="Strength · estimated 1RM" action={lift ? 'History' : undefined} onAction={() => lift && go.exercise(lift)} />
          {lifts.length ? (
            <ApexCard>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                {lifts.map((l) => <Chip key={l.id} label={l.name} selected={l.id === lift} onPress={() => setLiftId(l.id)} style={{ paddingHorizontal: 12 }} />)}
              </ScrollView>
              {trend.length > 0 && (
                <View style={styles.trend}>
                  <Metric label="Current e1RM" value={wt(trend[trend.length - 1].e1rm, u)} unit={u} size="numL"
                    sub={trend.length > 1 ? `${trend[trend.length - 1].e1rm - trend[0].e1rm >= 0 ? '+' : ''}${wt(trend[trend.length - 1].e1rm - trend[0].e1rm, u)} ${u} over ${trend.length} sessions` : 'First session logged'} />
                  <Sparkline values={trend.map((t) => t.e1rm)} />
                </View>
              )}
              {trend.length > 0 && <Txt v="bodySm" style={{ marginTop: S.sm }}>Top set {wt(Math.max(...trend.map((t) => t.topWeight)), u)} {u} · best e1RM {wt(Math.max(...trend.map((t) => t.e1rm)), u)} {u}</Txt>}
            </ApexCard>
          ) : (
            <EmptyState title="No lifts logged" message="Complete a workout to start tracking load, reps and estimated 1RM." />
          )}

          {!jumpFirst && jump}

          <SectionHeader title="Recent sessions" action={history.length ? 'All' : undefined} onAction={() => setTab('history')} />
          {history.length ? (
            <ApexCard padded={false}>
              {history.slice(0, 3).map((h, i) => (
                <View key={h.id}>
                  {i > 0 && <Divider inset={64} />}
                  <SessionRow {...h.row} onPress={() => go.session(h.id)} />
                </View>
              ))}
            </ApexCard>
          ) : (
            <EmptyState mark title="No workout history" message="Your training history starts here." />
          )}

          <SectionHeader title="Athletic" action="Log test" onAction={() => setSheet('test')} />
          <ApexCard style={styles.three}>
            {athletic.map((a) => (
              <View key={a.kind} style={{ flex: 1 }}>
                <Metric label={a.label} value={a.best ?? '—'} unit={a.best ? 'cm' : undefined} />
              </View>
            ))}
          </ApexCard>

          <SectionHeader title="Body" action="Log" onAction={() => setSheet('body')} />
          <ContextPrompt situation="body" style={{ marginBottom: S.md }} />
          <ApexCard>
            {BODY.map((b, i) => {
              const xs = latestBody(b.kind);
              const last = xs[xs.length - 1];
              const prev = xs[xs.length - 2];
              // bodyweight follows the athlete's units; measurements stay in cm
              const show = (v: number) => (b.kind === 'bodyweight' ? wt(v, u) : `${+v.toFixed(1)}`);
              return (
                <View key={b.kind}>
                  {i > 0 && <Divider />}
                  <View style={styles.kv}>
                    <Txt v="body" color={last ? C.text : C.text3}>{b.label}</Txt>
                    <Txt v="label" color={last ? C.text : C.text3} style={{ fontFamily: F.semibold }}>
                      {last ? `${show(last.value)} ${b.kind === 'bodyweight' ? u : b.unit}` : '—'}{last && prev ? `  (${last.value - prev.value >= 0 ? '+' : ''}${show(last.value - prev.value)})` : ''}
                    </Txt>
                  </View>
                </View>
              );
            })}
          </ApexCard>
        </>
      )}

      {sheet === 'test' && <LogSheet title="Log jump test" options={ATHLETIC.map((a) => ({ kind: a.kind, label: a.label, unit: 'cm', initial: a.kind === 'broad' ? 240 : 60 }))}
        onSave={(k, v) => apex.addPerformance(k as PerformanceKind, v)} onClose={() => setSheet(null)} />}
      {sheet === 'body' && <LogSheet title="Log body metric"
        options={BODY.map((b) => b.kind === 'bodyweight'
          ? { ...b, unit: u, initial: +toUnits(latestBody(b.kind).pop()?.value ?? 80, u).toFixed(1) }
          : { ...b, initial: latestBody(b.kind).pop()?.value ?? 40 })}
        onSave={(k, v) => apex.addBodyMetric(k as BodyMetricKind, k === 'bodyweight' ? fromUnits(v, u) : v)} onClose={() => setSheet(null)} />}
    </Screen>
  );
}

function LogSheet({ title, options, onSave, onClose }: { title: string; options: { kind: string; label: string; unit: string; initial: number }[]; onSave: (kind: string, v: number) => void; onClose: () => void }) {
  const [kind, setKind] = useState(options[0].kind);
  const opt = options.find((o) => o.kind === kind)!;
  const [value, setValue] = useState(opt.initial);
  return (
    <BottomSheet visible onClose={onClose} title={title} footer={<Button label="Save" disabled={!(value > 0)} onPress={() => { onSave(kind, value); onClose(); }} />}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: S.lg }}>
        {options.map((o) => <Chip key={o.kind} label={o.label} selected={o.kind === kind} onPress={() => { setKind(o.kind); setValue(o.initial); }} style={{ flexBasis: '30%', flexGrow: 1 }} />)}
      </View>
      <Stepper label={opt.label} unit={opt.unit} value={value} step={opt.unit === 'kg' ? 0.1 : opt.unit === 'lb' ? 0.2 : 0.5} min={0} max={opt.unit === 'kg' ? 400 : opt.unit === 'lb' ? 880 : 500} onChange={setValue} />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  prRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingVertical: S.md, minHeight: 60 },
  trend: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: S.lg },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm, minHeight: 32 },
  track: { flex: 1, height: 6, backgroundColor: C.line, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, backgroundColor: C.text, borderRadius: 3 },
  zone: { position: 'absolute', top: 0, bottom: 0, backgroundColor: C.lineStrong },
  insight: { flexDirection: 'row', alignItems: 'flex-start', gap: S.md, padding: S.lg },
  insightMark: { width: 3, alignSelf: 'stretch', borderRadius: 1, backgroundColor: C.text3 },
  loadRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingVertical: S.md, minHeight: 64 },
  footnote: { marginTop: S.sm, color: C.text3 },
  barNum: { width: 34, textAlign: 'right', fontVariant: ['tabular-nums'] },
  kv: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  three: { flexDirection: 'row', gap: S.md },
});
