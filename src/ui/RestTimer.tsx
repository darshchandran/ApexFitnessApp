import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import type { RestState } from '@/domain/types';
import { apex } from '@/services/useApex';
import { Icon, type IconName } from './Icon';
import { ProgressBar, Txt, tap } from './primitives';
import { C, F, GUTTER, R, S } from './theme';

export const clock = (sec: number) => {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Seconds left. Wall-clock based, so time spent backgrounded or locked is counted. */
export const restLeft = (r: RestState, now: number) => r.pausedLeft ?? Math.max(0, (r.endsAt - now) / 1000);

/** Timer commands. State lives on the session, so leaving the screen or restarting keeps it. */
export function restControls(instanceId: string, rest: RestState | undefined) {
  const set = (r: RestState | undefined) => apex.setRest(instanceId, r);
  return {
    start(sec: number) {
      set({ endsAt: Date.now() + sec * 1000, total: sec });
    },
    add(sec: number) {
      if (!rest) return;
      const left = Math.max(0, restLeft(rest, Date.now()) + sec);
      set(rest.pausedLeft !== undefined
        ? { ...rest, pausedLeft: left, total: Math.max(rest.total, left) }
        : { endsAt: Date.now() + left * 1000, total: Math.max(rest.total, left) });
    },
    toggle() {
      if (!rest) return;
      set(rest.pausedLeft !== undefined
        ? { endsAt: Date.now() + rest.pausedLeft * 1000, total: rest.total }
        : { ...rest, pausedLeft: restLeft(rest, Date.now()) });
    },
    stop() {
      set(undefined);
    },
  };
}

/** Re-renders only itself; refreshes immediately when the app returns to the foreground. */
export function useNow(intervalMs: number, active = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && setNow(Date.now()));
    return () => {
      clearInterval(t);
      sub.remove();
    };
  }, [intervalMs, active]);
  return now;
}

function TimerButton({ icon, label, text, onPress }: { icon?: IconName; label: string; text?: string; onPress: () => void }) {
  return (
    <Pressable onPress={() => { tap(); onPress(); }} accessibilityRole="button" accessibilityLabel={label} hitSlop={2}
      style={({ pressed }) => [styles.btn, pressed && { backgroundColor: C.pressed }]}>
      {icon ? <Icon name={icon} size={20} /> : <Text style={styles.btnText}>{text}</Text>}
    </Pressable>
  );
}

/** Docked rest timer. Strong numerals, quiet chrome. */
export function RestTimer({ instanceId, rest }: { instanceId: string; rest: RestState | undefined }) {
  const paused = rest?.pausedLeft !== undefined;
  const now = useNow(250, !!rest && !paused);
  const left = rest ? restLeft(rest, now) : 0;
  const done = !!rest && left <= 0;

  useEffect(() => {
    if (done && Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [done]);

  if (!rest) return null;
  const c = restControls(instanceId, rest);
  return (
    <View style={styles.wrap} accessibilityLiveRegion="polite">
      <ProgressBar value={rest.total ? 1 - left / rest.total : 1} color={done ? C.text : C.accent} height={2} />
      <View style={styles.row}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Txt v="overline" color={done ? C.accent : C.text3} numberOfLines={1}>{done ? 'Rest done' : paused ? 'Paused' : 'Rest'}</Txt>
          <Text style={[styles.time, done && { color: C.accent }]} accessibilityLabel={done ? 'Rest complete' : `Rest ${clock(left)} remaining`} maxFontSizeMultiplier={1.2}>
            {done ? 'GO' : clock(left)}
          </Text>
        </View>
        {!done && <TimerButton text="−15" label="Remove 15 seconds" onPress={() => c.add(-15)} />}
        {!done && <TimerButton text="+15" label="Add 15 seconds" onPress={() => c.add(15)} />}
        {!done && <TimerButton icon={paused ? 'play' : 'pause'} label={paused ? 'Resume rest' : 'Pause rest'} onPress={c.toggle} />}
        <TimerButton icon={done ? 'close' : 'skip'} label={done ? 'Dismiss' : 'Skip rest'} onPress={c.stop} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: C.bg, borderTopWidth: StyleSheet.hairlineWidth, borderColor: C.lineStrong, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingHorizontal: GUTTER, paddingTop: 6 },
  time: { fontFamily: F.displayBold, fontSize: 32, lineHeight: 34, color: C.text, fontVariant: ['tabular-nums'] },
  btn: { width: 48, height: 46, borderRadius: R.md, backgroundColor: C.raised, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: C.line },
  btnText: { fontFamily: F.semibold, fontSize: 14, color: C.text },
});
