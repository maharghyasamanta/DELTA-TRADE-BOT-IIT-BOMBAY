import { useCallback, useEffect, useState } from 'react';
import {
  onAuthStateChanged,
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
}

function extractAuthError(
  err: unknown,
  fallbackMessage: string,
): { code: string | null; message: string } {
  if (err && typeof err === 'object') {
    const record = err as { code?: unknown; message?: unknown };
    const code =
      typeof record.code === 'string' && record.code.trim()
        ? record.code.trim()
        : null;
    const message =
      typeof record.message === 'string' && record.message.trim()
        ? record.message.trim()
        : err instanceof Error && err.message.trim()
          ? err.message.trim()
          : fallbackMessage;
    return { code, message };
  }
  if (typeof err === 'string' && err.trim()) {
    return { code: null, message: err.trim() };
  }
  return { code: null, message: fallbackMessage };
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

    const unsubscribe = onAuthStateChanged(
      auth,
      (nextUser) => {
        setUser(nextUser);
        setAuthReady(true);
      },
      (err) => {
        setAuthReady(true);
        const extracted = extractAuthError(err, 'Firebase authentication listener failed.');
        setAuthError({
          code: extracted.code,
          message: extracted.message,
          timestamp: new Date().toISOString(),
        });
      },
    );

    return () => unsubscribe();
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

    setIsSigningIn(true);
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const extracted = extractAuthError(err, 'Google sign-in failed.');
      setAuthError({
        code: extracted.code,
        message: extracted.message,
        timestamp: new Date().toISOString(),
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
