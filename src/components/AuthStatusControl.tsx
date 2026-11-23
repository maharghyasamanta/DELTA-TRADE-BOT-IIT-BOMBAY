import type { User } from 'firebase/auth';
import { LogIn, LogOut, ShieldAlert } from 'lucide-react';
import type { AuthErrorState } from '../hooks/useFirebaseAuth';

interface AuthStatusControlProps {
  user: User | null;
  authReady: boolean;
  isSigningIn: boolean;
  authError: AuthErrorState | null;
  isFirebaseConfigured: boolean;
  firebaseConfigError: string | null;
  onSignIn: () => void;
  onSignOut: () => void;
}

export function AuthStatusControl({
  user,
  authReady,
  isSigningIn,
  authError,
  isFirebaseConfigured,
  firebaseConfigError,
  onSignIn,
  onSignOut,
}: AuthStatusControlProps) {
  if (!isFirebaseConfigured) {
    return (
      <span
        title={firebaseConfigError ?? 'Firebase not configured'}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/70 px-2.5 py-1.5 font-mono text-[11px] text-slate-400 whitespace-nowrap shrink-0"
      >
        <ShieldAlert className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
        <span>Auth Unconfigured</span>
      </span>
    );
  }

  if (!authReady) {
    return (
      <span className="inline-flex items-center rounded-md border border-slate-800 bg-slate-900/70 px-2.5 py-1.5 font-mono text-[11px] text-slate-400 whitespace-nowrap shrink-0">
        Checking Auth…
      </span>
    );
  }

  if (user) {
    const label = user.displayName || user.email || 'Signed-in User';
    const initial = label.trim().charAt(0).toUpperCase() || 'U';

    return (
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex items-center gap-2 rounded-md border border-slate-800 bg-[#111A2E] px-2.5 py-1">
          {user.photoURL ? (
            <img
              src={user.photoURL}
              alt={label}
              referrerPolicy="no-referrer"
              className="h-5 w-5 rounded-full object-cover"
            />
          ) : (
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-sky-900/60 font-mono text-[10px] font-semibold text-sky-200">
              {initial}
            </span>
          )}
          <span className="max-w-[140px] truncate text-xs font-medium text-slate-200">
            {label}
          </span>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-700/80 bg-[#0B1120] px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-600 hover:text-slate-100 cursor-pointer whitespace-nowrap shrink-0"
        >
          <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Sign out</span>
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onSignIn}
      disabled={isSigningIn}
      title={
        authError
          ? `${authError.code ? `[${authError.code}] ` : ''}${authError.message} (${authError.timestamp})`
          : 'Sign in with Google'
      }
      className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-950/30 px-3 py-1.5 text-xs font-medium text-sky-200 hover:bg-sky-900/40 cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-60"
    >
      <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{isSigningIn ? 'Signing in…' : 'Sign in with Google'}</span>
    </button>
  );
}
