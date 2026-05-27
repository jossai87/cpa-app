import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, RotateCcw } from 'lucide-react';
import api from '../lib/api';
import Spinner from './Spinner';
import type { TaxSession } from '../types';

interface TaxHistoryListProps {
  onSelectSession: (session: TaxSession) => void;
  /** Optional — invoked after a session was deleted. */
  onSessionDeleted?: (sessionId: string) => void;
  /** Optional — invoked when the user clicks the reload button on a row. */
  onReloadSession?: (session: TaxSession) => void;
  /** Optional — highlights the currently selected session row. */
  selectedSessionId?: string;
}

function useTaxHistory() {
  return useQuery({
    queryKey: ['tax', 'history'],
    queryFn: () =>
      api.get<{ sessions: TaxSession[] }>('/tax/history').then((r) => r.data.sessions),
    staleTime: 5 * 60 * 1000,
  });
}

function useDeleteTaxSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      api.delete<{ sessionId: string; deleted: boolean }>(
        `/tax/history/${sessionId}`
      ).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tax', 'history'] });
    },
  });
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

const STATUS_STYLES: Record<string, string> = {
  complete: 'bg-green-100 text-green-700',
  pending: 'bg-yellow-100 text-yellow-700',
  error: 'bg-red-100 text-red-700',
};

export default function TaxHistoryList({
  onSelectSession,
  onSessionDeleted,
  onReloadSession,
  selectedSessionId,
}: TaxHistoryListProps) {
  const { data: sessions, isLoading, isError } = useTaxHistory();
  const deleteMut = useDeleteTaxSession();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [reloadingId, setReloadingId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner size="sm" />
        Loading history…
      </div>
    );
  }

  if (isError) {
    return (
      <p role="alert" className="text-sm text-red-600">
        Failed to load session history.
      </p>
    );
  }

  if (!sessions || sessions.length === 0) {
    return (
      <p className="text-sm text-slate-400">
        No previous sessions. Submit a tax analysis to get started.
      </p>
    );
  }

  const handleSelect = (session: TaxSession) => {
    api
      .get<TaxSession>(`/tax/history/${session.sessionId}`)
      .then((r) => onSelectSession(r.data))
      .catch(() => {
        onSelectSession(session);
      });
  };

  const handleDeleteClick = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    setPendingDeleteId(sessionId);
  };

  const handleReloadClick = async (e: React.MouseEvent, session: TaxSession) => {
    e.stopPropagation();
    if (!onReloadSession) return;
    const ok = window.confirm(
      `Reload the inputs from this session into the form? Your current draft will be replaced.`
    );
    if (!ok) return;
    setReloadingId(session.sessionId);
    try {
      const full = await api
        .get<TaxSession>(`/tax/history/${session.sessionId}`)
        .then((r) => r.data);
      onReloadSession(full);
    } catch (err) {
      window.alert(
        `Failed to reload session: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setReloadingId(null);
    }
  };

  const confirmDelete = async (sessionId: string) => {
    try {
      await deleteMut.mutateAsync(sessionId);
      onSessionDeleted?.(sessionId);
    } catch {
      // surface error inline next to the row instead of throwing
    } finally {
      setPendingDeleteId(null);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <table className="w-full text-sm" aria-label="Tax session history">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50">
            <th scope="col" className="px-4 py-3 text-left font-medium text-slate-700">
              Tax Year
            </th>
            <th scope="col" className="px-4 py-3 text-left font-medium text-slate-700">
              Entity Type
            </th>
            <th scope="col" className="px-4 py-3 text-left font-medium text-slate-700">
              Date
            </th>
            <th scope="col" className="px-4 py-3 text-left font-medium text-slate-700">
              Status
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium text-slate-700 w-px">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {sessions.map((session) => {
            const isPendingDelete = pendingDeleteId === session.sessionId;
            const isDeleting = deleteMut.isPending && pendingDeleteId === session.sessionId;
            return (
              <tr
                key={session.sessionId}
                onClick={() => !isPendingDelete && handleSelect(session)}
                onKeyDown={(e) => {
                  if (isPendingDelete) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleSelect(session);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={`View session: ${session.taxYear} ${session.entityType}`}
                aria-pressed={selectedSessionId === session.sessionId}
                className={`group transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${
                  isPendingDelete
                    ? 'bg-amber-50'
                    : selectedSessionId === session.sessionId
                      ? 'bg-blue-50 border-l-2 border-l-blue-500'
                      : 'hover:bg-slate-50 cursor-pointer'
                }`}
              >
                <td className="px-4 py-3 font-medium text-slate-900">{session.taxYear}</td>
                <td className="px-4 py-3 text-slate-700">{session.entityType}</td>
                <td className="px-4 py-3 text-slate-500">{formatDate(session.createdAt)}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${
                      STATUS_STYLES[session.status] ?? 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {session.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {isPendingDelete ? (
                    <div
                      className="inline-flex items-center gap-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span className="text-xs text-amber-700 font-medium">
                        Are you sure?
                      </span>
                      <button
                        type="button"
                        onClick={() => confirmDelete(session.sessionId)}
                        disabled={isDeleting}
                        className="text-xs px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 disabled:bg-slate-300"
                      >
                        {isDeleting ? 'Deleting…' : 'Delete'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDeleteId(null)}
                        disabled={isDeleting}
                        className="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-100"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="inline-flex items-center gap-1">
                      {onReloadSession && (
                        <button
                          type="button"
                          onClick={(e) => handleReloadClick(e, session)}
                          disabled={reloadingId === session.sessionId}
                          aria-label={`Reload ${session.taxYear} session inputs into form`}
                          title="Reload inputs into form"
                          className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1.5 rounded text-slate-400 hover:bg-blue-100 hover:text-blue-700 transition disabled:opacity-50"
                        >
                          {reloadingId === session.sessionId ? (
                            <Spinner size="sm" />
                          ) : (
                            <RotateCcw className="w-4 h-4" />
                          )}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(e) => handleDeleteClick(e, session.sessionId)}
                        aria-label={`Delete ${session.taxYear} session`}
                        title="Delete session"
                        className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1.5 rounded text-slate-400 hover:bg-red-100 hover:text-red-700 transition"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
