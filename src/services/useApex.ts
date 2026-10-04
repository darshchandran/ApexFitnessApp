import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { createApex } from './apex';

/** The app's single instance, persisted on device (localStorage on web). */
export const apex = createApex(AsyncStorage);

let started: Promise<void> | undefined;
export const startApex = () => (started ??= apex.init());

export function useApex() {
  return useSyncExternalStore(apex.subscribe, apex.getState, apex.getState);
}
