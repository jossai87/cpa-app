import { useState, useRef, useEffect } from 'react';
import { Copy, Check, Pencil, X, Eye, EyeOff } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import Spinner from './Spinner';
import type { Credential } from '../types';

interface CredentialRowProps {
  credential: Credential;
}

const COPY_CONFIRM_MS = 10_000;
const CLIPBOARD_CLEAR_MS = 60_000;

export default function CredentialRow({ credential }: CredentialRowProps) {
  const queryClient = useQueryClient();

  // Password copy state
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const [copyError, setCopyError] = useState<string | null>(null);
  const clipboardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Username copy state
  const [userCopyStatus, setUserCopyStatus] = useState<'idle' | 'copied'>('idle');
  const userCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Edit state — now covers all fields
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editUsername, setEditUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccess, setEditSuccess] = useState(false);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      if (userCopyTimerRef.current) clearTimeout(userCopyTimerRef.current);
    };
  }, []);

  const updateMutation = useMutation({
    mutationFn: ({ id, ...fields }: { id: string; name?: string; url?: string; username?: string; password?: string }) =>
      api.put(`/credentials/${id}`, fields).then((r) => r.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['credentials'] });
      setEditSuccess(true);
      setIsEditing(false);
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => setEditSuccess(false), 5000);
    },
    onError: (err: { response?: { data?: { error?: string } } }) => {
      setEditError(err.response?.data?.error ?? 'Failed to update. Please try again.');
    },
  });

  const handleCopy = async () => {
    setCopyStatus('copying');
    setCopyError(null);

    try {
      const res = await api.post<{ password: string }>(`/credentials/${credential.id}/copy`);
      const rawPassword = res.data.password;

      // Write to clipboard — never store in state
      await navigator.clipboard.writeText(rawPassword);

      setCopyStatus('copied');

      // Clear confirmation after 10s
      confirmTimerRef.current = setTimeout(() => {
        setCopyStatus('idle');
      }, COPY_CONFIRM_MS);

      // Clear clipboard after 60s
      clipboardTimerRef.current = setTimeout(() => {
        void navigator.clipboard.writeText('').catch(() => {
          // Clipboard clear is best-effort
        });
      }, CLIPBOARD_CLEAR_MS);
    } catch (err) {
      const apiErr = err as { response?: { data?: { error?: string } } };
      const message =
        apiErr.response?.data?.error ??
        (err instanceof Error && err.name === 'NotAllowedError'
          ? 'Clipboard access denied. Please allow clipboard permissions.'
          : 'Failed to copy password.');
      setCopyError(message);
      setCopyStatus('error');
    }
  };

  const handleCopyUsername = async () => {
    try {
      await navigator.clipboard.writeText(credential.username);
      setUserCopyStatus('copied');
      userCopyTimerRef.current = setTimeout(() => setUserCopyStatus('idle'), 2000);
    } catch {
      // fallback — silently ignore
    }
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setEditError(null);

    // Build only the fields that changed
    const fields: { name?: string; url?: string; username?: string; password?: string } = {};
    if (editName.trim() && editName.trim() !== credential.name) fields.name = editName.trim();
    if (editUrl.trim() !== (credential.url ?? '')) fields.url = editUrl.trim();
    if (editUsername.trim() !== credential.username) fields.username = editUsername.trim();
    if (newPassword) {
      if (newPassword !== confirmPassword) { setEditError('Passwords do not match.'); return; }
      if (newPassword.length < 8) { setEditError('Password must be at least 8 characters.'); return; }
      fields.password = newPassword;
    }
    if (Object.keys(fields).length === 0) { setEditError('No changes to save.'); return; }
    updateMutation.mutate({ id: credential.id, ...fields });
  };

  const canSubmitEdit = !updateMutation.isPending && (
    (editName.trim() && editName.trim() !== credential.name) ||
    editUrl.trim() !== (credential.url ?? '') ||
    editUsername.trim() !== credential.username ||
    (newPassword.length >= 8 && newPassword === confirmPassword)
  );

  return (
    <>
      <tr className="align-top">
        <td className="px-4 py-3 font-medium text-brand-900 whitespace-nowrap">{credential.name}</td>
        <td className="px-4 py-3">
          {credential.url ? (
            <a
              href={credential.url}
              target="_blank"
              rel="noopener noreferrer"
              title={credential.url}
              className="text-brand-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded inline-block max-w-full truncate align-middle"
            >
              {(() => {
                try {
                  return new URL(credential.url).hostname;
                } catch {
                  return credential.url;
                }
              })()}
            </a>
          ) : (
            <span className="text-brand-400 italic">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-brand-700 truncate" title={credential.username}>
          <span className="flex items-center gap-1.5">
            <span className="truncate">{credential.username}</span>
            <button
              onClick={() => void handleCopyUsername()}
              aria-label={`Copy username for ${credential.name}`}
              title="Copy username"
              className="flex-shrink-0 text-brand-300 hover:text-brand-600 transition-colors"
            >
              {userCopyStatus === 'copied'
                ? <Check className="w-3.5 h-3.5 text-green-500" />
                : <Copy className="w-3.5 h-3.5" />
              }
            </button>
          </span>
        </td>
        <td
          className="px-4 py-3 text-brand-400 tracking-widest whitespace-nowrap"
          aria-label="Password hidden"
        >
          ••••••••
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center justify-end gap-2">
            {/* Copy button */}
            <button
              onClick={() => void handleCopy()}
              disabled={copyStatus === 'copying'}
              aria-label={`Copy password for ${credential.name}`}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-brand-200 text-brand-600 hover:bg-brand-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {copyStatus === 'copying' ? (
                <Spinner size="sm" />
              ) : copyStatus === 'copied' ? (
                <Check className="w-3.5 h-3.5 text-green-500" aria-hidden="true" />
              ) : (
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              {copyStatus === 'copied' ? 'Copied' : 'Copy'}
            </button>

            {/* Edit button */}
            <button
              onClick={() => {
                if (!isEditing) {
                  setEditName(credential.name);
                  setEditUrl(credential.url ?? '');
                  setEditUsername(credential.username);
                  setNewPassword('');
                  setConfirmPassword('');
                  setEditError(null);
                }
                setIsEditing((v) => !v);
              }}
              aria-label={isEditing ? `Cancel editing ${credential.name}` : `Edit ${credential.name}`}
              aria-expanded={isEditing}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-brand-200 text-brand-600 hover:bg-brand-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {isEditing ? <X className="w-3.5 h-3.5" aria-hidden="true" /> : <Pencil className="w-3.5 h-3.5" aria-hidden="true" />}
              {isEditing ? 'Cancel' : 'Edit'}
            </button>
          </div>

          {/* Copy error */}
          {copyStatus === 'error' && copyError && (
            <p role="alert" className="mt-1 text-xs text-red-600">
              {copyError}
            </p>
          )}

          {/* Edit success */}
          {editSuccess && (
            <p role="status" className="mt-1 text-xs text-green-600">
              Password updated.
            </p>
          )}
        </td>
      </tr>

      {/* Inline edit form row */}
      {isEditing && (
        <tr>
          <td colSpan={5} className="px-4 pb-4 bg-brand-50">
            <form onSubmit={handleEditSubmit} aria-label={`Edit ${credential.name}`} className="pt-3 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* Name */}
                <div>
                  <label htmlFor={`edit-name-${credential.id}`} className="block text-xs font-medium text-brand-600 mb-1">Name</label>
                  <input id={`edit-name-${credential.id}`} type="text" value={editName} onChange={(e) => setEditName(e.target.value)}
                    className="block w-full rounded-lg border border-brand-300 bg-white text-sm py-2 px-3 focus:outline-none focus:ring-2 focus:ring-brand-500" />
                </div>
                {/* URL */}
                <div>
                  <label htmlFor={`edit-url-${credential.id}`} className="block text-xs font-medium text-brand-600 mb-1">URL</label>
                  <input id={`edit-url-${credential.id}`} type="text" value={editUrl} onChange={(e) => setEditUrl(e.target.value)}
                    className="block w-full rounded-lg border border-brand-300 bg-white text-sm py-2 px-3 focus:outline-none focus:ring-2 focus:ring-brand-500" />
                </div>
                {/* Username */}
                <div>
                  <label htmlFor={`edit-user-${credential.id}`} className="block text-xs font-medium text-brand-600 mb-1">Username / Email</label>
                  <input id={`edit-user-${credential.id}`} type="text" value={editUsername} onChange={(e) => setEditUsername(e.target.value)}
                    className="block w-full rounded-lg border border-brand-300 bg-white text-sm py-2 px-3 focus:outline-none focus:ring-2 focus:ring-brand-500" />
                </div>
                {/* New password */}
                <div>
                  <label htmlFor={`new-pw-${credential.id}`} className="block text-xs font-medium text-brand-600 mb-1">New Password <span className="text-brand-400 font-normal">(leave blank to keep)</span></label>
                  <div className="relative">
                    <input id={`new-pw-${credential.id}`} type={showNewPassword ? 'text' : 'password'} value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)} placeholder="New password" autoComplete="new-password"
                      className="block w-full rounded-lg border border-brand-300 bg-white text-sm py-2 pl-3 pr-9 focus:outline-none focus:ring-2 focus:ring-brand-500" />
                    <button type="button" onClick={() => setShowNewPassword((v) => !v)} aria-label={showNewPassword ? 'Hide' : 'Show'}
                      className="absolute inset-y-0 right-2 flex items-center text-brand-400 hover:text-brand-600">
                      {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                {/* Confirm password — only show if new password entered */}
                {newPassword && (
                  <div>
                    <label htmlFor={`confirm-pw-${credential.id}`} className="block text-xs font-medium text-brand-600 mb-1">Confirm Password</label>
                    <div className="relative">
                      <input id={`confirm-pw-${credential.id}`} type={showConfirmPassword ? 'text' : 'password'} value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Confirm password" autoComplete="new-password"
                        className="block w-full rounded-lg border border-brand-300 bg-white text-sm py-2 pl-3 pr-9 focus:outline-none focus:ring-2 focus:ring-brand-500" />
                      <button type="button" onClick={() => setShowConfirmPassword((v) => !v)} aria-label={showConfirmPassword ? 'Hide' : 'Show'}
                        className="absolute inset-y-0 right-2 flex items-center text-brand-400 hover:text-brand-600">
                        {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3">
                <button type="submit" disabled={!canSubmitEdit}
                  className="px-4 py-2 bg-brand-700 text-white text-sm font-medium rounded-lg hover:bg-brand-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                  {updateMutation.isPending ? 'Saving…' : 'Save Changes'}
                </button>
                {editError && <p role="alert" className="text-xs text-red-600">{editError}</p>}
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}
