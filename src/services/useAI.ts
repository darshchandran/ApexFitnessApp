import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { createAssistant } from './ai';
import { memorySecrets, type SecretStore } from './aiSession';
import { apex } from './useApex';

/**
 * The refresh token goes to the Keychain / Keystore, readable only on this device once it has been
 * unlocked. The web build has no secure store, so its sign-in lasts for the session only.
 */
const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const secrets: SecretStore = Platform.OS === 'web'
  ? memorySecrets()
  : {
    get: (k) => SecureStore.getItemAsync(k, KEYCHAIN),
    set: (k, v) => SecureStore.setItemAsync(k, v, KEYCHAIN),
    remove: (k) => SecureStore.deleteItemAsync(k, KEYCHAIN),
  };

/** The app's APEX AI client. The server address comes from the build; there are no credentials in it. */
export const assistant = createAssistant({ store: AsyncStorage, apex, secrets, defaultUrl: process.env.EXPO_PUBLIC_APEX_AI_URL });

let started: Promise<void> | undefined;
export const startAssistant = () => (started ??= assistant.init());
