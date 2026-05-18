import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithRedirect, signOut } from 'aws-amplify/auth';
import { useAuth } from '../lib/auth';
import Spinner from '../components/Spinner';

/**
 * Login page — redirects authenticated users to the dashboard,
 * and unauthenticated users to the Cognito Hosted UI.
 */
export default function Login() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const triggered = useRef(false);

  useEffect(() => {
    if (loading || triggered.current) return;

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
  }, [user, loading, navigate]);

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

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-50">
      <div className="text-center">
        <Spinner size="lg" />
        <p className="mt-4 text-sm text-slate-500">Redirecting to login…</p>
      </div>
    </div>
  );
}
