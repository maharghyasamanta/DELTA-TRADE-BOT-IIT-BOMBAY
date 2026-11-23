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
  message: string;
  timestamp: string;
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
        setAuthError({
          message: err.message,
          timestamp: new Date().toISOString(),
        });
      },
    );

    return () => unsubscribe();
  }, []);

  const signInWithGoogle = useCallback(async () => {
    if (!auth || !googleProvider) {
      setAuthError({
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
      setAuthError({
        message: err instanceof Error ? err.message : 'Google sign-in failed.',
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
      setAuthError({
        message: err instanceof Error ? err.message : 'Sign-out failed.',
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
