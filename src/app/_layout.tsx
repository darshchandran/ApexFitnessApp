import { BarlowCondensed_500Medium, BarlowCondensed_600SemiBold, BarlowCondensed_700Bold } from '@expo-google-fonts/barlow-condensed';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';
import { useFonts } from 'expo-font';
import { DarkTheme, Stack, ThemeProvider, type ErrorBoundaryProps } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { nextQuestion } from '@/domain/profile';
import { apex, startApex, useApex } from '@/services/useApex';
import { FirstLaunch } from '@/ui/context';
import { ApexLockup } from '@/ui/Brand';
import { C, F, GUTTER, R, S } from '@/ui/theme';

SplashScreen.preventAutoHideAsync();

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: C.bg, card: C.bg, border: C.line, primary: C.accent, text: C.text },
};

const COLLECTION_LABEL: Record<string, string> = {
  templates: 'gym templates', plyoTemplates: 'plyometric templates', plan: 'weekly plan', instances: 'some sessions',
  basketball: 'practice log', records: 'records', settings: 'settings', user: 'profile', recovery: 'check-ins',
  bodyMetrics: 'body log', performance: 'jump tests',
};

/** Quiet, persistent notices for storage problems. Never a stack trace. */
function StorageNotice() {
  const { saveError, recovered } = useApex();
  const insets = useSafeAreaInsets();
  if (!saveError && !recovered.length) return null;
  return (
    <View style={[styles.notice, { top: insets.top + S.sm }]} accessibilityLiveRegion="assertive" accessibilityRole="alert">
      <Text style={styles.noticeText}>
        {saveError
          ? 'Couldn’t save to this device. Your changes are kept on screen.'
          : `Some saved data couldn’t be read and was reset: ${recovered.map((c) => COLLECTION_LABEL[c] ?? c).join(', ')}.`}
      </Text>
      <Pressable onPress={() => (saveError ? apex.retrySave() : apex.dismissRecovered())} accessibilityRole="button" hitSlop={8} style={styles.noticeBtn}>
        <Text style={styles.noticeBtnText}>{saveError ? 'RETRY' : 'OK'}</Text>
      </Pressable>
    </View>
  );
}

export function ErrorBoundary({ retry }: ErrorBoundaryProps) {
  return (
    <View style={[styles.splash, { padding: GUTTER, gap: S.lg }]}>
      <ApexLockup size={56} tagline={false} />
      <Text style={styles.errTitle}>Something went wrong</Text>
      <Text style={styles.errBody}>Your training data is saved on this device. Try again — if it keeps happening, restart Apex.</Text>
      <Pressable onPress={retry} accessibilityRole="button" style={styles.errBtn}>
        <Text style={styles.errBtnText}>TRY AGAIN</Text>
      </Pressable>
    </View>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold,
    BarlowCondensed_500Medium, BarlowCondensed_600SemiBold, BarlowCondensed_700Bold,
  });
  const { ready, data } = useApex();
  const [launchedAt] = useState(() => new Date());
  // never hold the app on the splash for fonts: after a short wait, system fonts are fine
  const [fontWait, setFontWait] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setFontWait(false), 3000);
    return () => clearTimeout(t);
  }, []);
  const fonts = fontsLoaded || !!fontError || !fontWait;

  useEffect(() => {
    startApex();
    // back from background (or past midnight): today's plan and adaptations may have changed
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && apex.getState().ready) apex.refreshToday();
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (fonts && ready) SplashScreen.hideAsync();
  }, [fonts, ready]);

  if (!fonts || !ready) {
    return (
      <View style={styles.splash}>
        <ApexLockup size={88} />
      </View>
    );
  }

  // one question before the app, and only the first time: everything else is asked in context
  if (nextQuestion(data, 'launch', launchedAt, { today: apex.today() })) {
    return (
      <View style={styles.page}>
        <StatusBar style="light" />
        <View style={styles.column}><FirstLaunch /></View>
      </View>
    );
  }

  return (
    <ThemeProvider value={theme}>
      <StatusBar style="light" />
      <View style={styles.page}>
        <View style={styles.column}>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg }, freezeOnBlur: true }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="workout/[id]" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom', gestureEnabled: false }} />
            <Stack.Screen name="practice" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
            <Stack.Screen name="template/[id]" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="session/[id]" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="exercise/[id]" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="settings" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="ai" options={{ animation: 'slide_from_right' }} />
          </Stack>
          <StorageNotice />
        </View>
      </View>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' },
  page: { flex: 1, backgroundColor: C.bg },
  // ponytail: phone-width column on web; native fills the screen
  column: { flex: 1, width: '100%', maxWidth: Platform.OS === 'web' ? 520 : undefined, alignSelf: 'center' },
  notice: {
    position: 'absolute', left: S.md, right: S.md, flexDirection: 'row', alignItems: 'center', gap: S.md,
    padding: S.md, borderRadius: R.md, backgroundColor: C.raised, borderWidth: 1, borderColor: C.danger,
  },
  noticeText: { flex: 1, color: C.text, fontFamily: F.medium, fontSize: 13, lineHeight: 18 },
  noticeBtn: { minHeight: 36, paddingHorizontal: S.md, justifyContent: 'center', borderRadius: R.sm, backgroundColor: C.text },
  noticeBtnText: { color: C.bg, fontFamily: F.semibold, fontSize: 12, letterSpacing: 1.1 },
  errTitle: { color: C.text, fontFamily: F.semibold, fontSize: 18, marginTop: S.xl },
  errBody: { color: C.text2, fontFamily: F.regular, fontSize: 15, lineHeight: 21, textAlign: 'center', maxWidth: 320 },
  errBtn: { height: 52, paddingHorizontal: S.xxl, borderRadius: R.md, backgroundColor: C.accent, justifyContent: 'center' },
  errBtnText: { color: C.onAccent, fontFamily: F.semibold, fontSize: 14, letterSpacing: 1.3 },
});
