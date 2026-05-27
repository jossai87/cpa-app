/**
 * ChatHistory — slide-in panel showing past conversations for a chatbot.
 *
 * Used by both SalesChat and GmailChat. Sessions are stored in DynamoDB
 * with a 30-day TTL. Each session shows:
 *   - Date/time it started (Central Time)
 *   - Preview of the first user message
 *   - Click to reload the conversation
 *   - Delete button
 */

import { useState } from 'react';
import { History, Trash2, MessageSquare, Loader2, X, ChevronRight } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface HistorySession {
  sessionId: string;
  type: 'sales' | 'inbox';
  preview: string;
  startedAt: string;
  lastMessageAt: string;
}

interface FullSession extends HistorySession {
  messages: HistoryMessage[];
}

interface Props {
  type: 'sales' | 'inbox';
  onLoadSession: (messages: HistoryMessage[]) => void;
  /** Accent color class for the header */
  accentClass?: string;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Chicago' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Chicago',
  });
}

/** Group sessions by date label */
function groupByDate(sessions: HistorySession[]): Array<{ label: string; sessions: HistorySession[] }> {
  const groups = new Map<string, HistorySession[]>();
  for (const s of sessions) {
    const label = fmtDate(s.startedAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(s);
  }
  return Array.from(groups.entries()).map(([label, sessions]) => ({ label, sessions }));
}

export default function ChatHistory({ type, onLoadSession, accentClass = 'bg-blue-600' }: Props) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const historyQ = useQuery<{ sessions: HistorySession[] }>({
    queryKey: ['chat-history', type],
    queryFn: () => api.get<{ sessions: HistorySession[] }>(`/chat/history?type=${type}`).then((r) => r.data),
    enabled: open,
    staleTime: 30 * 1000,
  });

  const deleteMut = useMutation({
    mutationFn: (sessionId: string) =>
      api.delete(`/chat/history/${sessionId}?type=${type}`).then((r) => r.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['chat-history', type] });
    },
  });

  async function loadSession(sessionId: string) {
    setLoadingId(sessionId);
    try {
      const res = await api.get<{ session: FullSession }>(`/chat/history/${sessionId}?type=${type}`);
      onLoadSession(res.data.session.messages);
      setOpen(false);
    } catch (err) {
      console.error('Failed to load session:', err);
    } finally {
      setLoadingId(null);
    }
  }

  const sessions = historyQ.data?.sessions ?? [];
  const groups = groupByDate(sessions);

  return (
    <>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Conversation history"
        className="text-white/70 hover:text-white transition-colors"
        aria-label="View conversation history"
      >
        <History className="w-4 h-4" />
      </button>

      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-[60] bg-slate-900/30"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Drawer */}
      {open && (
        <div className="fixed bottom-0 right-6 z-[70] w-[340px] max-w-[calc(100vw-2rem)] bg-white rounded-t-2xl shadow-2xl border border-slate-200 flex flex-col max-h-[70vh]">
          {/* Header */}
          <div className={`flex items-center justify-between px-4 py-3 rounded-t-2xl ${accentClass}`}>
            <div className="flex items-center gap-2">
              <History className="w-4 h-4 text-white" />
              <span className="text-sm font-semibold text-white">Conversation History</span>
              {sessions.length > 0 && (
                <span className="text-[10px] bg-white/20 text-white px-1.5 py-0.5 rounded-full">
                  {sessions.length}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-white/70 hover:text-white"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto">
            {historyQ.isLoading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading history…
              </div>
            ) : sessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-slate-400">
                <MessageSquare className="w-8 h-8 opacity-30" />
                <p className="text-sm">No conversations yet</p>
                <p className="text-[11px] text-slate-400">Your chats will appear here for 30 days</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {groups.map(({ label, sessions: groupSessions }) => (
                  <div key={label}>
                    <p className="px-4 py-2 text-[10px] font-semibold text-slate-400 uppercase tracking-wide bg-slate-50 sticky top-0">
                      {label}
                    </p>
                    {groupSessions.map((s) => (
                      <div
                        key={s.sessionId}
                        className="flex items-start gap-2 px-4 py-3 hover:bg-slate-50 group"
                      >
                        <button
                          type="button"
                          onClick={() => void loadSession(s.sessionId)}
                          disabled={loadingId === s.sessionId}
                          className="flex-1 min-w-0 text-left"
                        >
                          <div className="flex items-center justify-between gap-2 mb-0.5">
                            <span className="text-[11px] text-slate-400">
                              {fmtTime(s.startedAt)} CT
                            </span>
                            {loadingId === s.sessionId ? (
                              <Loader2 className="w-3 h-3 animate-spin text-slate-400 flex-shrink-0" />
                            ) : (
                              <ChevronRight className="w-3 h-3 text-slate-300 group-hover:text-slate-500 flex-shrink-0 transition-colors" />
                            )}
                          </div>
                          <p className="text-xs text-slate-700 leading-snug line-clamp-2">
                            {s.preview}
                          </p>
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteMut.mutate(s.sessionId)}
                          disabled={deleteMut.isPending}
                          className="flex-shrink-0 text-slate-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 mt-0.5"
                          aria-label="Delete conversation"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-slate-100 text-[10px] text-slate-400 text-center">
            Conversations auto-delete after 30 days · All times Central
          </div>
        </div>
      )}
    </>
  );
}

// ── Hook: auto-save conversation after each exchange ──────────────────

import { useRef, useCallback } from 'react';

export function useChatHistory(type: 'sales' | 'inbox') {
  const sessionIdRef = useRef<string>(crypto.randomUUID());
  const startedAtRef = useRef<string>(new Date().toISOString());

  const save = useCallback(
    async (messages: Array<{ role: string; content: string }>) => {
      if (messages.length < 2) return; // need at least one exchange
      const stamped = messages.map((m, i) => ({
        ...m,
        // Assign timestamps: spread evenly if not already present
        timestamp: (m as { timestamp?: string }).timestamp ?? new Date(Date.now() - (messages.length - i) * 1000).toISOString(),
      }));
      try {
        await api.post('/chat/history', {
          sessionId: sessionIdRef.current,
          type,
          messages: stamped,
          startedAt: startedAtRef.current,
        });
      } catch (err) {
        // Non-fatal — history save failure shouldn't break the chat
        console.warn('Failed to save chat history:', err);
      }
    },
    [type]
  );

  function resetSession() {
    sessionIdRef.current = crypto.randomUUID();
    startedAtRef.current = new Date().toISOString();
  }

  return { save, resetSession, sessionId: sessionIdRef.current };
}
