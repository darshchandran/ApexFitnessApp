import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Easing, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Chip, IconButton, Stepper, Txt } from './primitives';
import { C, GUTTER, R, S } from './theme';

export function BottomSheet({ visible, onClose, title, children, footer }: {
  visible: boolean; onClose: () => void; title?: string; children: ReactNode; footer?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const [y] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (visible) Animated.timing(y, { toValue: 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }).start();
    else y.setValue(1);
  }, [visible, y]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.wrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" accessibilityRole="button">
          <View style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim }]} />
        </Pressable>
        <Animated.View
          style={[styles.sheet, { paddingBottom: insets.bottom + S.lg, transform: [{ translateY: y.interpolate({ inputRange: [0, 1], outputRange: [0, 600] }) }] }]}
          accessibilityViewIsModal
        >
          <View style={styles.handle} />
          {title && (
            <View style={styles.header}>
              <Txt v="h3" accessibilityRole="header" style={{ flex: 1 }}>{title}</Txt>
              <IconButton icon="close" label="Close" onPress={onClose} color={C.text2} />
            </View>
          )}
          <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: S.lg }} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          {footer && <View style={{ paddingHorizontal: GUTTER, paddingTop: S.sm }}>{footer}</View>}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** A quick number to log (a body metric, a jump test); several kinds get a picker. */
export function LogSheet({ title, options, onSave, onClose }: { title: string; options: { kind: string; label: string; unit: string; initial: number }[]; onSave: (kind: string, v: number) => void; onClose: () => void }) {
  const [kind, setKind] = useState(options[0].kind);
  const opt = options.find((o) => o.kind === kind)!;
  const [value, setValue] = useState(opt.initial);
  return (
    <BottomSheet visible onClose={onClose} title={title} footer={<Button label="Save" disabled={!(value > 0)} onPress={() => { onSave(kind, value); onClose(); }} />}>
      {options.length > 1 && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: S.lg }}>
        {options.map((o) => <Chip key={o.kind} label={o.label} selected={o.kind === kind} onPress={() => { setKind(o.kind); setValue(o.initial); }} style={{ flexBasis: '30%', flexGrow: 1 }} />)}
      </View>}
      <Stepper label={opt.label} unit={opt.unit} value={value} step={opt.unit === 'kg' ? 0.1 : opt.unit === 'lb' ? 0.2 : 0.5} min={0} max={opt.unit === 'kg' ? 400 : opt.unit === 'lb' ? 880 : 500} onChange={setValue} />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: C.surface, borderTopLeftRadius: R.lg + 4, borderTopRightRadius: R.lg + 4, maxHeight: '88%',
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: C.lineStrong, width: '100%', maxWidth: 640, alignSelf: 'center',
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: C.lineStrong, marginTop: S.sm },
  header: { flexDirection: 'row', alignItems: 'center', paddingLeft: GUTTER, paddingRight: S.sm, paddingTop: S.xs, paddingBottom: S.sm },
});
