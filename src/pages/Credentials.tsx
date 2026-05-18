import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import api from '../lib/api';
import CredentialRow from '../components/CredentialRow';
import Spinner from '../components/Spinner';
import type { Credential } from '../types';

function useCredentials() {
  return useQuery({
    queryKey: ['credentials'],
    queryFn: () =>
      api.get<{ credentials: Credential[] }>('/credentials').then((r) => r.data.credentials),
    staleTime: 5 * 60 * 1000,
  });
}

export default function Credentials() {
  const { data: credentials, isLoading, isError, error } = useCredentials();

  return (
    <div className="min-h-screen bg-brand-50">
      {/* Header */}
      <header className="bg-white border-b border-brand-200 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center gap-4">
          <Link
            to="/"
            className="flex items-center gap-1.5 text-sm text-brand-500 hover:text-brand-900 transition-colors"
            aria-label="Back to dashboard"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            Dashboard
          </Link>
          <h1 className="text-xl font-semibold text-brand-900">Credential Vault</h1>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        {isLoading && (
          <div className="flex items-center gap-3 text-sm text-brand-500">
            <Spinner size="sm" />
            Loading credentials…
          </div>
        )}

        {isError && (
          <div
            role="alert"
            className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700"
          >
            {(error as { response?: { data?: { error?: string } } })?.response?.data?.error ??
              'Failed to load credentials. Please try again.'}
          </div>
        )}

        {!isLoading && !isError && credentials?.length === 0 && (
          <p className="text-sm text-brand-500">No credentials stored.</p>
        )}

        {!isLoading && !isError && credentials && credentials.length > 0 && (
          <div className="bg-white rounded-lg border border-brand-200 overflow-x-auto">
            <table className="w-full min-w-[60rem] text-sm" aria-label="Stored credentials">
              <thead>
                <tr className="border-b border-brand-200 bg-brand-50">
                  <th
                    scope="col"
                    className="px-4 py-3 text-left font-medium text-brand-700 w-44"
                  >
                    Service
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-left font-medium text-brand-700 w-44"
                  >
                    URL
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-left font-medium text-brand-700"
                  >
                    Username
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-left font-medium text-brand-700 w-28"
                  >
                    Password
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-right font-medium text-brand-700 w-44"
                  >
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-100">
                {credentials.map((cred) => (
                  <CredentialRow key={cred.id} credential={cred} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
