import { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/ui/Icon';
import { tap } from '@/ui/primitives';
import { C, F } from '@/ui/theme';

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

const TABS: Record<string, { label: string; icon: IconName }> = {
  index: { label: 'Home', icon: 'home' },
  train: { label: 'Train', icon: 'train' },
  progress: { label: 'Progress', icon: 'progress' },
  program: { label: 'Program', icon: 'program' },
};

function ApexTabBar({ state, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 8) }]} accessibilityRole="tablist">
      {state.routes.map((route, i) => {
        const t = TABS[route.name];
        if (!t) return null;
        const focused = state.index === i;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={t.label}
            onPress={() => {
              tap();
              const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
              if (!focused && !e.defaultPrevented) navigation.navigate(route.name);
            }}
            style={styles.item}
          >
            <View style={[styles.indicator, focused && { backgroundColor: C.accent }]} />
            <Icon name={t.icon} size={22} color={focused ? C.text : C.text3} />
            <Text style={[styles.label, { color: focused ? C.text : C.text3 }]} maxFontSizeMultiplier={1.2}>{t.label.toUpperCase()}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function TabLayout() {
  return (
    <Tabs tabBar={(p) => <ApexTabBar {...p} />} screenOptions={{ headerShown: false, freezeOnBlur: true, sceneStyle: { backgroundColor: C.bg } }}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="train" />
      <Tabs.Screen name="progress" />
      <Tabs.Screen name="program" />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', backgroundColor: C.bg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, paddingTop: 10, paddingBottom: 4, minHeight: 56 },
  indicator: { position: 'absolute', top: 0, width: 24, height: 2, borderRadius: 1, backgroundColor: 'transparent' },
  label: { fontFamily: F.semibold, fontSize: 10, letterSpacing: 1.2 },
});
