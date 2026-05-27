/**
 * FsAssistant — unified floating AI assistant.
 *
 * Implements Task 15.2.
 *
 * Replaces the page-scoped `<SalesChat />` and `<GmailChat />`
 * bubbles with a single global bubble that routes every question
 * through the AgentCore orchestrator (`POST /assistant/chat`).
 *
 * Mount point: `<ProtectedShell />` in `App.tsx` — that is, on every
 * authenticated route, but never on `/login` or `/callback` (Reqs
 * 1.1–1.2). State persists across navigation via the Zustand store
 * (Req 1.5).
 *
 * Feature-gated by `VITE_ASSISTANT_ENABLED`. When the flag is `false`
 * (the default until the cutover release in Task 18.1), the component
 * returns `null` and no bubble appears.
 *
 * Header label is exactly "FS Assistant" (Req 1.4). The panel chrome
 * mirrors `SalesChat`/`GmailChat` so the visual transition at cutover
 * is invisible.
 */

import { useEffect, useRef, useState } from 'react';
import { Bot, Loader2, MessageCircle, Send, X } from 'lucide-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import api from '../lib/api';
import {
  useFsAssistantStore,
  type AssistantMessage,
  type AttachmentRef,
  type HistorySession,
  type Route,
} from '../lib/fsAssistantStore';
import ChatMessageRenderer from './ChatMessageRenderer';
import AttachmentChip from './AttachmentChip';

interface AssistantPostResponse {
  sessionId: string;
  status: 'processing' | 'complete' | 'error';
  // status='complete' synthetic responses (turn cap) include these inline
  reply?: string;
  route?: Route;
  attachments?: AttachmentRef[];
}

interface AssistantGetResponse {
  sessionId: string;
  status: 'processing' | 'complete' | 'error';
  reply?: string;
  route?: Route;
  attachments?: AttachmentRef[];
  errorMessage?: string;
}

interface ListHistoryResponse {
  sessions: HistorySession[];
}

interface GetHistoryResponse {
  session: {
    sessionId: string;
    type: 'sales' | 'inbox' | 'assistant';
    messages: AssistantMessage[];
  };
}

const SUGGESTED_QUESTIONS: Array<{ category: string; question: string }> = [
  { category: 'Sales', question: "What were today's sales?" },
  { category: 'Sales', question: 'Which brand has the highest YTD net sales?' },
  { category: 'Inbox', question: 'Any pending invoices in my inbox?' },
  { category: 'Inbox', question: 'Did Brooks email us recently?' },
  { category: 'Mixed', question: 'Did the brand with the highest return rate email us this week?' },
];

/** Read the Vite feature flag once at module load. */
const ASSISTANT_ENABLED =
  String(import.meta.env['VITE_ASSISTANT_ENABLED'] ?? 'false').toLowerCase() ===
  'true';

export default function FsAssistant() {
  const open = useFsAssistantStore((s) => s.open);
  const setOpen = useFsAssistantStore((s) => s.setOpen);
  const toggleOpen = useFsAssistantStore((s) => s.toggleOpen);
  const messages = useFsAssistantStore((s) => s.messages);
  const sessionId = useFsAssistantStore((s) => s.sessionId);
  const setSessionId = useFsAssistantStore((s) => s.setSessionId);
  const appendUserMessage = useFsAssistantStore((s) => s.appendUserMessage);
  const appendAssistantReply = useFsAssistantStore(
    (s) => s.appendAssistantReply
  );
  const clearSession = useFsAssistantStore((s) => s.clearSession);
  const loadSession = useFsAssistantStore((s) => s.loadSession);

  const [draft, setDraft] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the latest message visible.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus the input when the panel opens.
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 100);
  }, [open]);

  // Load the unified history list when the panel toggles to open.
  // Uses ?type=all so legacy Sales/Inbox sessions appear alongside
  // the new FS Assistant ones (design.md §Component 5).
  const historyQuery = useQuery<ListHistoryResponse>({
    queryKey: ['assistant', 'history', 'all'],
    queryFn: () =>
      api.get<ListHistoryResponse>('/chat/history?type=all').then((r) => r.data),
    enabled: open && showHistory,
  });

  /**
   * Submit a turn. Architecture:
   *   1. POST /assistant/chat → 202 with sessionId (or 200 + complete
   *      for the synthetic turn-cap reply path)
   *   2. Poll GET /assistant/chat/{sessionId} every 2.5s until status
   *      transitions out of 'processing' (or a 90s timeout safeguard
   *      fires)
   *   3. Append the assistant reply to the store
   *
   * The 90s polling cap is generous — the AgentCore + Sonnet 4.6 1M
   * orchestrator turn is typically 25-50s. If we hit the cap, surface
   * the error so the user can retry rather than spinning forever.
   */
  const chatMutation = useMutation({
    mutationFn: async (msgs: AssistantMessage[]) => {
      const post = await api.post<AssistantPostResponse>('/assistant/chat', {
        messages: msgs.map((m) => ({ role: m.role, content: m.content })),
        sessionId,
      });
      const initial = post.data;
      if (!sessionId) setSessionId(initial.sessionId);

      // Synthetic-complete shortcut (turn-cap reply, etc.)
      if (initial.status === 'complete') {
        return {
          reply: initial.reply ?? '',
          route: (initial.route ?? 'general') as Route,
          attachments: initial.attachments ?? [],
        };
      }

      // Poll until done.
      const sid = initial.sessionId;
      const start = Date.now();
      const POLL_INTERVAL_MS = 2500;
      const POLL_TIMEOUT_MS = 90_000;
      while (Date.now() - start < POLL_TIMEOUT_MS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        const poll = await api.get<AssistantGetResponse>(
          `/assistant/chat/${sid}`
        );
        if (poll.data.status === 'complete') {
          return {
            reply: poll.data.reply ?? '',
            route: (poll.data.route ?? 'general') as Route,
            attachments: poll.data.attachments ?? [],
          };
        }
        if (poll.data.status === 'error') {
          throw new Error(
            poll.data.errorMessage ??
              'The assistant ran into a problem. Please try again.'
          );
        }
      }
      throw new Error(
        'The assistant is taking longer than expected. Please try again.'
      );
    },
    onSuccess: (data) => {
      appendAssistantReply({
        content: data.reply,
        route: data.route,
        attachments: data.attachments,
      });
    },
    onError: (err) => {
      const msg =
        err instanceof Error
          ? err.message
          : 'Sorry, I ran into a problem reaching the assistant. Please try again.';
      appendAssistantReply({
        content: msg,
        route: 'general',
      });
    },
  });

  function send(text?: string) {
    const content = (text ?? draft).trim();
    if (!content || chatMutation.isPending) return;
    appendUserMessage(content);
    setDraft('');
    // Build the next-turn payload from the current store + this user message.
    const next: AssistantMessage[] = [
      ...messages,
      { role: 'user', content, timestamp: new Date().toISOString() },
    ];
    chatMutation.mutate(next);
  }

  function newChat() {
    clearSession();
  }

  async function loadHistorySession(s: HistorySession) {
    try {
      const { data } = await api.get<GetHistoryResponse>(
        `/chat/history/${s.sessionId}?type=${s.type}`
      );
      const msgs = data.session?.messages ?? [];
      loadSession(s.sessionId, msgs);
      // For legacy sessions (sales/inbox) we view-only — clear the
      // sessionId so the next user message starts a fresh assistant
      // session rather than trying to continue a legacy one (which
      // /assistant/chat doesn't know about).
      if (s.legacy) setSessionId(null);
      setShowHistory(false);
    } catch (err) {
      console.error('[FsAssistant] loadHistorySession error', err);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  if (!ASSISTANT_ENABLED) return null;

  return (
    <>
      {/* Floating bubble */}
      <button
        onClick={toggleOpen}
        aria-label={open ? 'Close FS Assistant' : 'Open FS Assistant'}
        className={`fixed bottom-6 right-6 z-50 flex items-center justify-center w-14 h-14 rounded-full shadow-lg transition-all duration-200 ${
          open
            ? 'bg-slate-700 hover:bg-slate-800'
            : 'bg-emerald-600 hover:bg-emerald-700'
        }`}
      >
        {open ? (
          <X className="w-6 h-6 text-white" />
        ) : (
          <MessageCircle className="w-6 h-6 text-white" />
        )}
        {!open && chatMutation.isPending && (
          <span className="absolute top-1 right-1 w-3 h-3 rounded-full bg-amber-400 animate-pulse" />
        )}
      </button>

      {/* Panel */}
      {open && (
        <div
          className="fixed bottom-24 right-6 z-50 flex flex-col bg-white rounded-2xl shadow-2xl border border-slate-200 w-[380px] max-w-[calc(100vw-2rem)]"
          // Req 1.3: panel capped at min(80vh, 720px)
          style={{ height: 'min(80vh, 720px)' }}
        >
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-100 rounded-t-2xl bg-emerald-600">
            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-white/20">
              <Bot className="w-4 h-4 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white leading-tight">
                FS Assistant
              </p>
              <p className="text-[10px] text-emerald-100">
                Sales · Inbox · Vendors — one assistant
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowHistory((v) => !v)}
                className="text-white/70 hover:text-white transition-colors text-[10px] border border-white/30 rounded px-1.5 py-0.5"
                title="Conversation history"
              >
                History
              </button>
              <button
                onClick={newChat}
                className="text-white/70 hover:text-white transition-colors text-[10px] border border-white/30 rounded px-1.5 py-0.5"
                title="New conversation"
              >
                New
              </button>
              <button
                onClick={() => setOpen(false)}
                className="text-white/70 hover:text-white transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* History overlay */}
          {showHistory && (
            <div className="flex-1 overflow-y-auto px-3 py-3 bg-slate-50 border-b border-slate-100">
              <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wide mb-2">
                Recent conversations
              </p>
              {historyQuery.isLoading && (
                <p className="text-xs text-slate-500">Loading…</p>
              )}
              {historyQuery.isError && (
                <p className="text-xs text-rose-600">Couldn't load history.</p>
              )}
              <div className="space-y-1.5">
                {(historyQuery.data?.sessions ?? []).map((s) => (
                  <button
                    key={`${s.type}-${s.sessionId}`}
                    onClick={() => void loadHistorySession(s)}
                    className="w-full text-left bg-white hover:bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-semibold text-slate-500 uppercase">
                        {s.displayLabel ?? s.type}
                      </span>
                      <span className="text-[9px] text-slate-400">
                        {new Date(s.lastMessageAt).toLocaleDateString()}
                      </span>
                    </div>
                    <p className="text-xs text-slate-700 mt-1 line-clamp-2">
                      {s.preview}
                    </p>
                  </button>
                ))}
                {!historyQuery.isLoading &&
                  (historyQuery.data?.sessions ?? []).length === 0 && (
                    <p className="text-xs text-slate-400 text-center py-4">
                      No conversations yet.
                    </p>
                  )}
              </div>
            </div>
          )}

          {/* Messages */}
          {!showHistory && (
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${
                    msg.role === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                      msg.role === 'user'
                        ? 'bg-emerald-600 text-white rounded-br-sm'
                        : 'bg-slate-100 text-slate-800 rounded-bl-sm'
                    }`}
                  >
                    {msg.role === 'assistant' ? (
                      <>
                        <ChatMessageRenderer
                          content={msg.content}
                          isUser={false}
                        />
                        {msg.attachments && msg.attachments.length > 0 && (
                          <div className="mt-2 space-y-1.5">
                            {msg.attachments.flatMap((ref) =>
                              ref.attachments.map((att) => (
                                <AttachmentChip
                                  key={`${ref.messageId}-${att.attachmentId}`}
                                  messageId={ref.messageId}
                                  attachment={att}
                                />
                              ))
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      msg.content
                    )}
                  </div>
                </div>
              ))}

              {chatMutation.isPending && (
                <div className="flex justify-start">
                  <div className="bg-slate-100 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1.5">
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
                      style={{ animationDelay: '0ms' }}
                    />
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
                      style={{ animationDelay: '150ms' }}
                    />
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
                      style={{ animationDelay: '300ms' }}
                    />
                  </div>
                </div>
              )}

              {messages.length === 1 && !chatMutation.isPending && (
                <div className="space-y-1.5 pt-1">
                  <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">
                    Try asking:
                  </p>
                  {SUGGESTED_QUESTIONS.map((q) => (
                    <button
                      key={q.question}
                      onClick={() => send(q.question)}
                      className="w-full text-left text-xs text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg px-3 py-2 transition-colors border border-emerald-100 flex items-center gap-2"
                    >
                      <span className="text-[9px] uppercase font-bold text-emerald-500 px-1 py-0.5 bg-white rounded border border-emerald-200">
                        {q.category}
                      </span>
                      <span className="flex-1">{q.question}</span>
                    </button>
                  ))}
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          )}

          {/* Input */}
          {!showHistory && (
            <div className="px-3 py-3 border-t border-slate-100">
              <div className="flex items-center gap-2 bg-slate-50 rounded-xl border border-slate-200 px-3 py-2 focus-within:border-emerald-400 focus-within:ring-1 focus-within:ring-emerald-400 transition-all">
                <input
                  ref={inputRef}
                  type="text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about sales, inventory, vendors, or your inbox…"
                  disabled={chatMutation.isPending}
                  className="flex-1 text-sm bg-transparent focus:outline-none text-slate-800 placeholder-slate-400 disabled:opacity-50"
                />
                <button
                  onClick={() => send()}
                  disabled={!draft.trim() || chatMutation.isPending}
                  className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  aria-label="Send"
                >
                  {chatMutation.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Send className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
              <p className="text-[9px] text-slate-400 text-center mt-1.5">
                FS Assistant routes to Sales · Inbox specialists
              </p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
