/**
 * FS Assistant — Zustand store for cross-route persistence.
 *
 * Implements Task 15.1.
 *
 * The `<FsAssistant />` bubble mounts once globally inside
 * `<ProtectedShell />` (Task 16.1). Without an external store, every
 * `<Outlet />` re-render between protected routes would reset the
 * panel state (open/closed, current session, message list). This store
 * survives the unmount/remount cycle so the bubble feels persistent.
 *
 * No persistence to localStorage — the chat messages are intentionally
 * scoped to the current tab; the chat-history endpoint is the durable
 * store (loaded on demand via the history list).
 */

import { create } from 'zustand';

export type Route = 'sales' | 'inbox' | 'both' | 'general';

export interface AttachmentRef {
  messageId: string;
  subject?: string;
  attachments: Array<{
    filename: string;
    mimeType: string;
    size: number;
    attachmentId: string;
  }>;
}

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  /** Set on assistant turns by the orchestrator. */
  route?: Route;
  /** Inbox attachments that came back with this assistant turn. */
  attachments?: AttachmentRef[];
}

/**
 * Lightweight session record returned by `GET /chat/history?type=all`.
 * The `legacy` and `displayLabel` fields are populated by the chatFn
 * Lambda (see lambda/chat/index.ts handleListHistory).
 */
export interface HistorySession {
  sessionId: string;
  type: 'sales' | 'inbox' | 'assistant';
  preview: string;
  startedAt: string;
  lastMessageAt: string;
  legacy?: boolean;
  displayLabel?: string;
}

const INITIAL_GREETING: AssistantMessage = {
  role: 'assistant',
  content:
    "Hi! I'm FS Assistant. Ask me about sales, inventory, vendors, or your inbox — I'll route it to the right specialist.",
};

interface FsAssistantState {
  open: boolean;
  sessionId: string | null;
  messages: AssistantMessage[];
  history: HistorySession[];
}

interface FsAssistantActions {
  setOpen(open: boolean): void;
  toggleOpen(): void;
  setSessionId(id: string | null): void;
  appendUserMessage(content: string): void;
  appendAssistantReply(reply: {
    content: string;
    route?: Route;
    attachments?: AttachmentRef[];
  }): void;
  loadSession(sessionId: string, messages: AssistantMessage[]): void;
  clearSession(): void;
  setHistory(history: HistorySession[]): void;
}

export type FsAssistantStore = FsAssistantState & FsAssistantActions;

export const useFsAssistantStore = create<FsAssistantStore>((set) => ({
  open: false,
  sessionId: null,
  messages: [INITIAL_GREETING],
  history: [],

  setOpen: (open) => set({ open }),
  toggleOpen: () => set((s) => ({ open: !s.open })),
  setSessionId: (id) => set({ sessionId: id }),

  appendUserMessage: (content) =>
    set((s) => ({
      messages: [
        ...s.messages,
        { role: 'user', content, timestamp: new Date().toISOString() },
      ],
    })),

  appendAssistantReply: ({ content, route, attachments }) =>
    set((s) => ({
      messages: [
        ...s.messages,
        {
          role: 'assistant',
          content,
          timestamp: new Date().toISOString(),
          route,
          attachments,
        },
      ],
    })),

  loadSession: (sessionId, messages) =>
    set({
      sessionId,
      messages: messages.length > 0 ? messages : [INITIAL_GREETING],
    }),

  clearSession: () =>
    set({
      sessionId: null,
      messages: [INITIAL_GREETING],
    }),

  setHistory: (history) => set({ history }),
}));
