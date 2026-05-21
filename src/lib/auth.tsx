import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from 'react';
import {
  getCurrentUser,
  fetchAuthSession,
  signOut as amplifySignOut,
} from 'aws-amplify/auth';
import { Hub } from 'aws-amplify/utils';

interface AuthUser {
  email: string;
  sub: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function isCallbackRoute(): boolean {
  return window.location.pathname === '/callback';
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const loadUser = useCallback(async () => {
    try {
      const cognitoUser = await getCurrentUser();
      // Read email from the ID token claims directly — avoids needing
      // the aws.cognito.signin.user.admin scope to call GetUser.
      const session = await fetchAuthSession();
      const idTokenClaims = session.tokens?.idToken?.payload;
      const email =
        (idTokenClaims?.['email'] as string | undefined) ?? cognitoUser.username;
      const sub =
        (idTokenClaims?.['sub'] as string | undefined) ?? cognitoUser.userId;

      setUser({ email, sub });
      setLoading(false);
    } catch (err) {
      console.warn('[auth] loadUser failed:', (err as Error).message);
      setUser(null);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = Hub.listen('auth', ({ payload }) => {
      console.log('[auth] Hub event:', payload.event);
      switch (payload.event) {
        case 'signedIn':
          void loadUser();
          break;
        case 'signedOut':
          setUser(null);
          setLoading(false);
          break;
        case 'tokenRefresh_failure':
          setUser(null);
          setLoading(false);
          break;
        case 'signInWithRedirect_failure':
          console.error('[auth] OAuth sign-in failed:', payload);
          setUser(null);
          setLoading(false);
          break;
      }
    });

    if (isCallbackRoute()) {
      console.log('[auth] On /callback — waiting for Hub signedIn event');
      const timeout = setTimeout(() => {
        console.warn('[auth] Callback timeout — checking session manually');
        void loadUser();
      }, 5000);
      return () => {
        unsubscribe();
        clearTimeout(timeout);
      };
    }

    void loadUser();

    return unsubscribe;
  }, [loadUser]);

  const signOut = useCallback(async () => {
    try {
      // Clear local Amplify session first
      await amplifySignOut({ global: false });
    } catch {
      // Ignore — we still want to redirect
    } finally {
      setUser(null);
      // Redirect through Cognito hosted UI logout to clear the session cookie.
      // Without this, Cognito auto-logs the user back in immediately.
      const domain = import.meta.env.VITE_COGNITO_DOMAIN as string;
      const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID as string;
      const logoutUri = encodeURIComponent((import.meta.env.VITE_APP_URL as string) + '/');
      window.location.href = `https://${domain}/logout?client_id=${clientId}&logout_uri=${logoutUri}`;
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
