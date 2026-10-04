import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { C } from './theme';

// Apex's own line icons: 24-unit grid, 1.8 stroke, square-ish geometry.
const PATHS = {
  home: 'M4 10.5 12 4l8 6.5V20h-5.5v-6h-5v6H4z',
  train: 'M6.5 7v10M17.5 7v10M3.5 9.5v5M20.5 9.5v5M6.5 12h11',
  progress: 'M4 20h16M6 16l4.5-5.5 3.5 3.5L19 7M15 7h4v4',
  program: 'M4.5 6.5h15v13h-15zM4.5 10.5h15M9 4v4M15 4v4M8 14h2M14 14h2',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  'chevron-right': 'M9.5 6l6 6-6 6',
  'chevron-left': 'M14.5 6l-6 6 6 6',
  'chevron-down': 'M6 9.5l6 6 6-6',
  'arrow-up': 'M12 19V5M6 11l6-6 6 6',
  'arrow-down': 'M12 5v14M6 13l6 6 6-6',
  swap: 'M5 8h13l-3.5-3.5M19 16H6l3.5 3.5',
  skip: 'M6 6l8 6-8 6zM18 6v12',
  play: 'M8 5.5l11 6.5-11 6.5z',
  pause: 'M8.5 6v12M15.5 6v12',
  note: 'M6 4h9l3 3v13H6zM9 11h6M9 15h4',
  trash: 'M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13',
  copy: 'M8.5 8.5h11v11h-11zM5 15.5V4.5h11',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20c1.5-3.5 4.2-5 7.5-5s6 1.5 7.5 5',
  timer: 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 9v4l2.5 2M9.5 2.5h5',
  link: 'M9 15l6-6M10.5 6.5l1.5-1.5a4 4 0 0 1 5.7 5.7L16.2 12M13.5 17.5L12 19a4 4 0 0 1-5.7-5.7L7.8 12',
  ball: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3v18M5.6 5.6c3 3 3 9.8 0 12.8M18.4 5.6c-3 3-3 9.8 0 12.8',
  bolt: 'M13 3L5 13.5h6L10 21l8-10.5h-6z',
  edit: 'M4 20h4L19 9l-4-4L4 16z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  list: 'M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01',
  settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M14 5v4M6 15v4',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22, color = C.text, strokeWidth = 1.8 }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ pointerEvents: 'none' }}>
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path d={PATHS[name]} stroke={color} strokeWidth={name === 'more' ? 3 : strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    </View>
  );
}
