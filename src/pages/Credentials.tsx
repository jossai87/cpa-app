import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Plus, X } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import { useAdmin } from '../lib/admin';
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

// Slugs that should always appear first, in order
const PINNED_SLUGS = ['gmail-corporate', 'gmail-personal'];

function sortCredentials(creds: Credential[]): Credential[] {
  return [...creds].sort((a, b) => {
    const ai = PINNED_SLUGS.indexOf(a.id);
    const bi = PINNED_SLUGS.indexOf(b.id);
    if (ai !== -1 && bi !== -1) return ai - bi; // both pinned — preserve pin order
    if (ai !== -1) return -1;                    // a pinned, b not — a first
    if (bi !== -1) return 1;                     // b pinned, a not — b first
    return a.name.localeCompare(b.name);         // neither pinned — alphabetical
  });
}

export default function Credentials() {
  const queryClient = useQueryClient();
  const { isVisible } = useAdmin();
  const { data: rawCredentials, isLoading, isError, error } = useCredentials();
  const credentials = rawCredentials
    ? sortCredentials(rawCredentials).filter((c) => {
        // Hide the corporate gmail entry from non-admins (unless admin override turns it on)
        if (c.id === 'gmail-corporate' && !isVisible('credentials.gmail-corporate')) return false;
        return true;
      })
    : rawCredentials;

  // New credential form
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newError, setNewError] = useState<string | null>(null);
  const [showNewPw, setShowNewPw] = useState(false);

  const createMutation = useMutation({
    mutationFn: (body: { name: string; url: string; username: string; password: string }) =>
      api.post('/credentials', body).then((r) => r.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['credentials'] });
      setShowNew(false);
      setNewName(''); setNewUrl(''); setNewUsername(''); setNewPassword('');
      setNewError(null);
    },
    onError: (err: { response?: { data?: { error?: string } } }) => {
      setNewError(err.response?.data?.error ?? 'Failed to create credential.');
    },
  });

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setNewError(null);
    if (!newName.trim()) { setNewError('Name is required.'); return; }
    if (!newPassword.trim()) { setNewError('Password is required.'); return; }
    createMutation.mutate({ name: newName.trim(), url: newUrl.trim(), username: newUsername.trim(), password: newPassword.trim() });
  }

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
          <button
            onClick={() => { setShowNew((v) => !v); setNewError(null); }}
            className="ml-auto flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-brand-700 text-white hover:bg-brand-800 transition-colors"
          >
            {showNew ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            {showNew ? 'Cancel' : 'Add Credential'}
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* New credential form */}
        {showNew && (
          <form onSubmit={handleCreate} className="bg-white rounded-lg border border-brand-200 p-5 mb-6 space-y-4">
            <h2 className="text-sm font-semibold text-brand-900">New Credential</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-brand-600 mb-1">Name *</label>
                <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. QuickBooks Online"
                  className="block w-full rounded-lg border border-brand-300 bg-white text-sm py-2 px-3 focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-brand-600 mb-1">URL</label>
                <input type="text" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="https://..."
                  className="block w-full rounded-lg border border-brand-300 bg-white text-sm py-2 px-3 focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-brand-600 mb-1">Username / Email</label>
                <input type="text" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="user@example.com"
                  className="block w-full rounded-lg border border-brand-300 bg-white text-sm py-2 px-3 focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-brand-600 mb-1">Password *</label>
                <div className="relative">
                  <input type={showNewPw ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Password" autoComplete="new-password"
                    className="block w-full rounded-lg border border-brand-300 bg-white text-sm py-2 pl-3 pr-9 focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  <button type="button" onClick={() => setShowNewPw((v) => !v)}
                    className="absolute inset-y-0 right-2 flex items-center text-brand-400 hover:text-brand-600 text-xs">
                    {showNewPw ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button type="submit" disabled={createMutation.isPending || !newName.trim() || !newPassword.trim()}
                className="px-4 py-2 bg-brand-700 text-white text-sm font-medium rounded-lg hover:bg-brand-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                {createMutation.isPending ? 'Saving…' : 'Save Credential'}
              </button>
              {newError && <p role="alert" className="text-xs text-red-600">{newError}</p>}
            </div>
          </form>
        )}
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
