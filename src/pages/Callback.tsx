import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import Spinner from '../components/Spinner';

/**
 * OAuth callback handler.
 *
 * Cognito redirects here after login with ?code=...&state=...
 * Amplify automatically exchanges the code for tokens during configure().
 * The Hub 'signedIn' event in AuthProvider fires when done, setting user.
 * Once user is set (or timeout), we navigate to the dashboard.
 */
export default function Callback() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const redirected = useRef(false);

  useEffect(() => {
    console.log('[callback] state:', { loading, hasUser: !!user });
    if (redirected.current) return;

    if (!loading) {
      redirected.current = true;
      if (user) {
        console.log('[callback] User loaded — navigating to dashboard');
        navigate('/', { replace: true });
      } else {
        console.warn('[callback] No user after exchange — navigating to login');
        navigate('/login', { replace: true });
      }
    }
  }, [user, loading, navigate]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-50">
      <div className="text-center">
        <Spinner size="lg" />
        <p className="mt-4 text-sm text-slate-500">Completing sign in…</p>
      </div>
    </div>
  );
}
