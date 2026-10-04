import { useId } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { C, F } from './theme';

// The supplied APEX mark, as vectors: a peak whose right leg runs unbroken while the
// left leg is split by a rising cut into an upper facet and a lower blade.
// Geometry is mirrored in scripts/make_brand.py — change both together.
export const MARK = {
  viewBox: '0 0 128 100',
  aspect: 1.28,
  upper: 'M64 0L128 100H101L62.6 40L30.7 52Z',
  facet: 'M64 0L30.7 52L62.6 40Z',
  lower: 'M26.9 57.9L62.5 44.5L24 100H0Z',
};

export type MarkVariant = 'metal' | 'light' | 'dark';

export function ApexMark({ size = 32, variant = 'metal' }: { size?: number; variant?: MarkVariant }) {
  // unique per instance: a shared id resolves to whichever copy comes first in the document,
  // which on web can sit inside a hidden screen and render the mark black
  const gid = `apexMetal${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const solid = variant === 'light' ? C.text : variant === 'dark' ? C.bg : `url(#${gid})`;
  return (
    <Svg width={size * MARK.aspect} height={size} viewBox={MARK.viewBox} accessibilityLabel="Apex" accessibilityRole="image">
      <Defs>
        <LinearGradient id={gid} x1="110" y1="0" x2="10" y2="100" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#FFFFFF" />
          <Stop offset="0.38" stopColor="#E4E4E8" />
          <Stop offset="0.72" stopColor="#A2A2A9" />
          <Stop offset="1" stopColor="#6C6C73" />
        </LinearGradient>
      </Defs>
      <Path d={MARK.upper} fill={solid} />
      {variant === 'metal' && <Path d={MARK.facet} fill="#000" opacity={0.2} />}
      <Path d={MARK.lower} fill={solid} />
    </Svg>
  );
}

// Λ P Ξ X — thin geometric strokes, the A without a crossbar.
const WORD = 'M1.5 27L14.5 3L27.5 27M52 27V3H66a8 8 0 0 1 0 16H52M94 4.5H120M94 15H116M94 25.5H120M142 3L168 27M168 3L142 27';

export function ApexWordmark({ width = 120, color = C.text }: { width?: number; color?: string }) {
  return (
    <Svg width={width} height={(width * 30) / 170} viewBox="0 0 170 30" accessibilityLabel="APEX" accessibilityRole="image">
      <Path d={WORD} stroke={color} strokeWidth={3.2} fill="none" strokeLinejoin="miter" />
    </Svg>
  );
}

export function ApexLockup({ orientation = 'stacked', size = 96, tagline = true }: { orientation?: 'stacked' | 'horizontal'; size?: number; tagline?: boolean }) {
  if (orientation === 'horizontal') {
    return (
      <View style={styles.row} accessible accessibilityLabel="Apex — Train, Adapt, Perform">
        <ApexMark size={size} />
        <View style={{ gap: size * 0.12 }}>
          <ApexWordmark width={size * 2.1} />
          {tagline && <Text style={[styles.tag, { fontSize: size * 0.13, letterSpacing: size * 0.05 }]}>TRAIN · ADAPT · PERFORM</Text>}
        </View>
      </View>
    );
  }
  return (
    <View style={styles.stack} accessible accessibilityLabel="Apex — Train, Adapt, Perform">
      <ApexMark size={size} />
      <View style={{ height: size * 0.28 }} />
      <ApexWordmark width={size * 1.9} />
      {tagline && <Text style={[styles.tag, { marginTop: size * 0.22, fontSize: size * 0.12, letterSpacing: size * 0.045 }]}>TRAIN · ADAPT · PERFORM</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  stack: { alignItems: 'center' },
  tag: { color: C.text2, fontFamily: F.medium },
});
