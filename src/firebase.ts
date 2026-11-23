import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, type Auth } from 'firebase/auth';
import {
  doc,
  getDocFromServer,
  getFirestore,
  type Firestore,
} from 'firebase/firestore';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: Array<{
      providerId?: string | null;
      email?: string | null;
    }>;
  };
}

interface RawFirebaseConfig {
  apiKey?: string;
  authDomain?: string;
  projectId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  firestoreDatabaseId?: string;
}

const configModules = import.meta.glob<{ default?: RawFirebaseConfig } & RawFirebaseConfig>(
  '/firebase-applet-config.json',
  { eager: true },
);

function loadRealFirebaseConfig(): RawFirebaseConfig | null {
  const matchedModule = configModules['/firebase-applet-config.json'];
  const fileConfig: RawFirebaseConfig | undefined = matchedModule
    ? matchedModule.default ?? matchedModule
    : undefined;

  const candidate: RawFirebaseConfig = {
    apiKey: fileConfig?.apiKey ?? import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: fileConfig?.authDomain ?? import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: fileConfig?.projectId ?? import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: fileConfig?.storageBucket ?? import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId:
      fileConfig?.messagingSenderId ?? import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: fileConfig?.appId ?? import.meta.env.VITE_FIREBASE_APP_ID,
    firestoreDatabaseId:
      fileConfig?.firestoreDatabaseId ?? import.meta.env.VITE_FIREBASE_DATABASE_ID,
  };

  if (
    !candidate.apiKey ||
    !candidate.authDomain ||
    !candidate.projectId ||
    !candidate.appId ||
    candidate.projectId === 'remixed-project-id'
  ) {
    return null;
  }

  return candidate;
}

const resolvedConfig = loadRealFirebaseConfig();

let app: FirebaseApp | null = null;
let db: Firestore | null = null;
let auth: Auth | null = null;
let googleProvider: GoogleAuthProvider | null = null;

if (resolvedConfig) {
  app = initializeApp({
    apiKey: resolvedConfig.apiKey,
    authDomain: resolvedConfig.authDomain,
    projectId: resolvedConfig.projectId,
    storageBucket: resolvedConfig.storageBucket,
    messagingSenderId: resolvedConfig.messagingSenderId,
    appId: resolvedConfig.appId,
  });
  db = resolvedConfig.firestoreDatabaseId
    ? getFirestore(app, resolvedConfig.firestoreDatabaseId)
    : getFirestore(app);
  auth = getAuth(app);
  googleProvider = new GoogleAuthProvider();
}

export const isFirebaseConfigured = Boolean(app && db && auth && googleProvider);
export const firebaseConfigError = isFirebaseConfigured
  ? null
  : 'Firebase not configured — provision firebase-applet-config.json or set VITE_FIREBASE_* env vars.';

export { auth, db, googleProvider };

async function testConnection(firestore: Firestore): Promise<void> {
  try {
    await getDocFromServer(doc(firestore, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

if (db) {
  void testConnection(db);
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): never {
  const currentUser = auth?.currentUser ?? null;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: currentUser?.uid ?? null,
      email: currentUser?.email ?? null,
      emailVerified: currentUser?.emailVerified ?? null,
      isAnonymous: currentUser?.isAnonymous ?? null,
      tenantId: currentUser?.tenantId ?? null,
      providerInfo:
        currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) ?? [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}
