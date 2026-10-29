import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { isSecureProductionUrl } from '../../../shared/networkPolicy';

function readEnv(name: string): string | undefined {
  const value = import.meta.env[name as keyof ImportMetaEnv];
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  return value;
}

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = readEnv(name);
  if (value === undefined) return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be set to "true" or "false".`);
}

function assertProdSecureHost(url: string | undefined): void {
  const mode = import.meta.env.PROD ? 'production' : 'development';
  if (!isSecureProductionUrl(mode, url)) {
    throw new Error(`In production, ${url} must use HTTPS.`);
  }
}

export const requireAuth = readBooleanEnv('VITE_REQUIRE_AUTH', true);
const useEmulator = readBooleanEnv('VITE_USE_FIREBASE_EMULATOR', false);

if (!requireAuth && (!import.meta.env.DEV || !useEmulator)) {
  throw new Error(
    'VITE_REQUIRE_AUTH=false is only supported in development with Firebase emulators.',
  );
}

const firebaseConfig = {
  apiKey: readEnv('VITE_FIREBASE_API_KEY') ?? 'demo-api-key',
  authDomain:
    readEnv('VITE_FIREBASE_AUTH_DOMAIN') ??
    'demo-income-tracker.firebaseapp.com',
  projectId: readEnv('VITE_FIREBASE_PROJECT_ID') ?? 'demo-income-tracker',
  appId: readEnv('VITE_FIREBASE_APP_ID') ?? 'demo-income-tracker-app-id',
};

assertProdSecureHost(readEnv('VITE_FIREBASE_AUTH_DOMAIN'));

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);

if (useEmulator) {
  const authHost =
    readEnv('VITE_FIREBASE_AUTH_EMULATOR_HOST') ?? '127.0.0.1:9099';
  const firestoreHost =
    readEnv('VITE_FIREBASE_FIRESTORE_EMULATOR_HOST') ?? '127.0.0.1:8080';
  const [firestoreHostname, firestorePort] = firestoreHost.split(':');
  const [authHostname, authPort] = authHost.split(':');

  connectAuthEmulator(auth, `http://${authHostname}:${Number(authPort)}`, {
    disableWarnings: true,
  });
  connectFirestoreEmulator(db, firestoreHostname, Number(firestorePort));
  const functionsHost =
    readEnv('VITE_FIREBASE_FUNCTIONS_EMULATOR_HOST') ?? '127.0.0.1:5001';
  const [functionsHostname, functionsPort] = functionsHost.split(':');
  connectFunctionsEmulator(functions, functionsHostname, Number(functionsPort));
}
