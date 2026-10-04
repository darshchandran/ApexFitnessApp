import AsyncStorage from '@react-native-async-storage/async-storage';

import { createAssistant } from './ai';
import { apex } from './useApex';

/** The app's APEX AI client. The server address may come from the build; the access token never does. */
export const assistant = createAssistant({ store: AsyncStorage, apex, defaultUrl: process.env.EXPO_PUBLIC_APEX_AI_URL });

let started: Promise<void> | undefined;
export const startAssistant = () => (started ??= assistant.init());
