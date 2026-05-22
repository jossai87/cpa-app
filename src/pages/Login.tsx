import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithRedirect, signOut } from 'aws-amplify/auth';
import { useAuth } from '../lib/auth';
import Spinner from '../components/Spinner';

/**
 * Login page — redirects authenticated users to the dashboard,
 * and unauthenticated users to the Cognito Hosted UI.
 *
 * When ?prompt=login is present (post sign-out), we show a "Sign in" button
 * instead of auto-redirecting so Cognito doesn't silently re-authenticate
 * using its SSO session cookie.
 */
export default function Login() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const triggered = useRef(false);

  // Detect post-logout landing — don't auto-redirect in this case.
  // We use sessionStorage (set by signOut before the Cognito redirect) rather
  // than a query param because some browsers/proxies strip query params from
  // OAuth-style redirect URIs.
  const promptLogin = (() => {
    try {
      return window.sessionStorage.getItem('justSignedOut') === '1';
    } catch {
      return false;
    }
  })();

  useEffect(() => {
    if (loading || triggered.current) return;

    // If we just signed out, force-clear any lingering user state and don't
    // auto-redirect. The "Sign in" button will trigger a fresh login flow.
    if (promptLogin) {
      // Even if Amplify still has a cached user, the Cognito session cookie
      // has been cleared — calling signOut again locally to be safe.
      if (user) {
        void signOut({ global: false }).catch(() => { /* ignore */ });
      }
      return;
    }

    if (user) {
      navigate('/', { replace: true });
      return;
    }

    triggered.current = true;

    async function redirectToLogin() {
      try {
        console.log('[login] Calling signInWithRedirect');
        await signInWithRedirect();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[login] signInWithRedirect failed:', message);

        if (
          message.includes('UserAlreadyAuthenticatedException') ||
          message.includes('already a signed in user')
        ) {
          try {
            await signOut({ global: false });
          } catch {
            // ignore
          }
          await new Promise((r) => setTimeout(r, 300));
          try {
            await signInWithRedirect();
          } catch (err2) {
            setError(
              `Login failed after retry: ${
                err2 instanceof Error ? err2.message : String(err2)
              }`
            );
          }
        } else {
          setError(`Login failed: ${message}`);
        }
      }
    }

    void redirectToLogin();
  }, [user, loading, navigate, promptLogin]);

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <div className="max-w-md p-6 bg-white rounded-lg shadow text-center">
          <h2 className="text-lg font-semibold text-red-600 mb-2">Sign-in error</h2>
          <p className="text-sm text-slate-700 mb-4">{error}</p>
          <button
            onClick={() => {
              triggered.current = false;
              setError(null);
              window.location.reload();
            }}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  // Post sign-out: show a sign-in button so the user explicitly initiates login
  if (promptLogin && !loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="surface px-10 py-12 text-center max-w-sm">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 mb-1.5">Foot Solutions</h1>
          <p className="text-sm text-slate-500 mb-7">You have been signed out.</p>
          <button
            onClick={() => {
              try { window.sessionStorage.removeItem('justSignedOut'); } catch { /* ignore */ }
              triggered.current = false;
              void signInWithRedirect();
            }}
            className="px-6 py-2.5 bg-slate-900 text-white rounded-xl hover:bg-slate-800 font-medium transition shadow-sm"
          >
            Sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <Spinner size="lg" />
        <p className="mt-4 text-sm text-slate-500">Redirecting to login…</p>
      </div>
    </div>
  );
}
