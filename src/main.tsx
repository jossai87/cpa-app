import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Amplify } from 'aws-amplify';
import App from './App';
import './index.css';

const callbackUrl = (import.meta.env.VITE_APP_URL as string) + '/callback';
const logoutUrl = (import.meta.env.VITE_APP_URL as string) + '/';

// Configure Amplify Auth with Cognito
Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID as string,
      userPoolClientId: import.meta.env.VITE_COGNITO_CLIENT_ID as string,
      loginWith: {
        oauth: {
          domain: import.meta.env.VITE_COGNITO_DOMAIN as string,
          scopes: ['openid', 'email'],
          redirectSignIn: [callbackUrl],
          redirectSignOut: [logoutUrl],
          responseType: 'code',
        },
      },
    },
  },
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5 * 60 * 1000,
    },
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found in the DOM');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
