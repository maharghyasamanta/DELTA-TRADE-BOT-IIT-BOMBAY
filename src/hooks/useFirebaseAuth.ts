import { useCallback, useEffect, useState } from 'react';
import {
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  auth,
  firebaseConfigError,
  googleProvider,
  isFirebaseConfigured,
} from '../firebase';

export interface AuthErrorState {
  code: string | null;
  message: string;
  timestamp: string;
  isStorageBlocked?: boolean;
}

function extractAuthError(
  err: unknown,
  fallbackMessage: string,
): { code: string | null; message: string; isStorageBlocked: boolean } {
  let code: string | null = null;
  let message = fallbackMessage;

  if (err && typeof err === 'object') {
    const record = err as { code?: unknown; name?: unknown; message?: unknown };
    if (typeof record.code === 'string' && record.code.trim()) {
      code = record.code.trim();
    } else if (typeof record.name === 'string' && record.name.trim() && record.name !== 'Error') {
      code = record.name.trim();
    }
    if (typeof record.message === 'string' && record.message.trim()) {
      message = record.message.trim();
    } else if (err instanceof Error && err.message.trim()) {
      message = err.message.trim();
    }
  } else if (typeof err === 'string' && err.trim()) {
    message = err.trim();
  }

  const lowerMsg = message.toLowerCase();
  const lowerCode = (code ?? '').toLowerCase();
  const isStorageBlocked =
    lowerCode.includes('web-storage-unsupported') ||
    lowerCode.includes('securityerror') ||
    lowerCode.includes('storage') ||
    lowerMsg.includes('localstorage') ||
    lowerMsg.includes('web storage') ||
    lowerMsg.includes('storage') ||
    lowerMsg.includes('cookie') ||
    lowerMsg.includes('access is denied') ||
    lowerMsg.includes('sandbox');

  return { code, message, isStorageBlocked };
}

function checkLocalStorageAccess(): AuthErrorState | null {
  if (typeof window === 'undefined') return null;
  try {
    const probeKey = '__regime_sentinel_auth_storage_probe__';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    return null;
  } catch (err) {
    const extracted = extractAuthError(
      err,
      'Browser localStorage is blocked in this preview iframe.',
    );
    return {
      code: extracted.code ?? 'storage/blocked',
      message: extracted.message,
      timestamp: new Date().toISOString(),
      isStorageBlocked: true,
    };
  }
}

export function useFirebaseAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState<boolean>(!isFirebaseConfigured);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authError, setAuthError] = useState<AuthErrorState | null>(null);

  useEffect(() => {
    if (!auth) {
      setAuthReady(true);
      setUser(null);
      return;
    }

    const activeAuth = auth;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    void (async () => {
      let persistenceError: AuthErrorState | null = checkLocalStorageAccess();

      try {
        await setPersistence(activeAuth, browserLocalPersistence);
      } catch (err) {
        const extracted = extractAuthError(
          err,
          'Unable to set browserLocalPersistence for Firebase Auth.',
        );
        persistenceError = {
          code: extracted.code ?? persistenceError?.code ?? 'auth/persistence-failed',
          message: extracted.message,
          timestamp: new Date().toISOString(),
          isStorageBlocked: extracted.isStorageBlocked || Boolean(persistenceError?.isStorageBlocked),
        };
      }

      if (cancelled) return;

      unsubscribe = onAuthStateChanged(
        activeAuth,
        (nextUser) => {
          if (cancelled) return;
          setUser(nextUser);
          setAuthReady(true);
          if (!nextUser && persistenceError) {
            setAuthError(persistenceError);
          }
        },
        (err) => {
          if (cancelled) return;
          setAuthReady(true);
          const extracted = extractAuthError(err, 'Firebase authentication listener failed.');
          setAuthError({
            code: extracted.code,
            message: extracted.message,
            timestamp: new Date().toISOString(),
            isStorageBlocked: extracted.isStorageBlocked,
          });
        },
      );
    })();

    return () => {
      cancelled = true;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    if (!auth || !googleProvider) {
      setAuthError({
        code: 'auth/not-configured',
        message:
          firebaseConfigError ?? 'Firebase Auth is not configured in this environment.',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const storageProbeError = checkLocalStorageAccess();
    if (storageProbeError) {
      setAuthError(storageProbeError);
      return;
    }

    setIsSigningIn(true);
    setAuthError(null);
    try {
      await setPersistence(auth, browserLocalPersistence);
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const extracted = extractAuthError(err, 'Google sign-in failed.');
      setAuthError({
        code: extracted.code,
        message: extracted.message,
        timestamp: new Date().toISOString(),
        isStorageBlocked: extracted.isStorageBlocked,
      });
    } finally {
      setIsSigningIn(false);
    }
  }, []);

  const signOutUser = useCallback(async () => {
    if (!auth) return;
    setAuthError(null);
    try {
      await signOut(auth);
    } catch (err) {
      const extracted = extractAuthError(err, 'Sign-out failed.');
      setAuthError({
        code: extracted.code,
        message: extracted.message,
        timestamp: new Date().toISOString(),
        isStorageBlocked: extracted.isStorageBlocked,
      });
    }
  }, []);

  const clearAuthError = useCallback(() => {
    setAuthError(null);
  }, []);

  return {
    user,
    authReady,
    isSigningIn,
    authError,
    clearAuthError,
    signInWithGoogle,
    signOutUser,
    isFirebaseConfigured,
    firebaseConfigError,
  };
}
