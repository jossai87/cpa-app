/**
 * GmailChat — floating AI chatbot for the Gmail Analysis page.
 *
 * Same pattern as SalesChat but points at POST /gmail/chat. The Lambda
 * grounds every answer in the owner's actual inbox (read-only).
 * When the model reads an email that has attachments, the response
 * includes attachment metadata and we render download chips below the bubble.
 */

import { useState, useRef, useEffect } from 'react';
import { MessageCircle, X, Send, Loader2, Mail } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import api from '../lib/api';
import { AttachmentRow, type AttachmentMeta } from './AttachmentChip';
import ChatMessageRenderer from './ChatMessageRenderer';
import ChatHistory, { useChatHistory, type HistoryMessage } from './ChatHistory';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Attachment chips to render below this bubble (assistant messages only) */
  attachments?: Array<{
    messageId: string;
    subject?: string;
    attachments: AttachmentMeta[];
  }>;
}

interface ChatResponse {
  reply: string;
  attachments?: Array<{
    messageId: string;
    subject?: string;
    attachments: AttachmentMeta[];
  }>;
}

const SUGGESTED_QUESTIONS = [
  'What invoices came in this week?',
  'Has Brooks reached out recently?',
  'Any customer appointment requests I have not replied to?',
  'What event invitations are in my inbox?',
  'Did Roland or Janell send anything I should know about?',
];

export default function GmailChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content:
        "Hi. I can answer questions grounded in your Gmail inbox — vendors, invoices, events, customer threads, follow-ups. Try one of the suggestions or ask anything.",
    },
  ]);
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { save, resetSession } = useChatHistory('inbox');

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 100);
  }, [open]);

  const chatMutation = useMutation({
    mutationFn: (msgs: ChatMessage[]) =>
      api
        .post<ChatResponse>('/gmail/chat', {
          // Strip attachment metadata before sending — backend only needs role+content
          messages: msgs.map((m) => ({ role: m.role, content: m.content })),
        })
        .then((r) => r.data),
    onSuccess: (data) => {
      const newMsg: ChatMessage = {
        role: 'assistant',
        content: data.reply,
        attachments: data.attachments,
      };
      setMessages((prev) => {
        const updated = [...prev, newMsg];
        // Auto-save (skip the initial greeting at index 0)
        const toSave = updated.slice(1);
        if (toSave.length >= 2) void save(toSave);
        return updated;
      });
    },
    onError: () => {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Sorry, I ran into an error. Please try again.' },
      ]);
    },
  });

  function send(text?: string) {
    const content = (text ?? draft).trim();
    if (!content || chatMutation.isPending) return;
    const userMsg: ChatMessage = { role: 'user', content };
    const next = [...messages, userMsg];
    setMessages(next);
    setDraft('');
    chatMutation.mutate(next);
  }

  function loadFromHistory(historyMessages: HistoryMessage[]) {
    resetSession();
    setMessages(historyMessages.map((m) => ({ role: m.role, content: m.content })));
  }

  function newChat() {
    resetSession();
    setMessages([{
      role: 'assistant',
      content: "Hi. I can answer questions grounded in your Gmail inbox — vendors, invoices, events, customer threads, follow-ups. Try one of the suggestions or ask anything.",
    }]);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close chat' : 'Open Gmail assistant'}
        className={`fixed bottom-6 right-6 z-50 flex items-center justify-center w-14 h-14 rounded-full shadow-lg transition-all duration-200 ${
          open ? 'bg-slate-700 hover:bg-slate-800' : 'bg-rose-600 hover:bg-rose-700'
        }`}
      >
        {open ? <X className="w-6 h-6 text-white" /> : <MessageCircle className="w-6 h-6 text-white" />}
        {!open && chatMutation.isPending && (
          <span className="absolute top-1 right-1 w-3 h-3 rounded-full bg-amber-400 animate-pulse" />
        )}
      </button>

      {open && (
        <div
          className="fixed bottom-24 right-6 z-50 flex flex-col bg-white rounded-2xl shadow-2xl border border-slate-200 w-[380px] max-w-[calc(100vw-2rem)]"
          style={{ height: '560px' }}
        >
          <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-100 rounded-t-2xl bg-rose-600">
            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-white/20">
              <Mail className="w-4 h-4 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white leading-tight">Inbox Assistant</p>
              <p className="text-[10px] text-rose-100">Powered by Amazon Bedrock · Reads your Gmail</p>
            </div>
            <div className="flex items-center gap-2">
              <ChatHistory type="inbox" onLoadSession={loadFromHistory} accentClass="bg-rose-600" />
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

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.map((msg, i) => (
              <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div
                  className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-rose-600 text-white rounded-br-sm'
                      : 'bg-slate-100 text-slate-800 rounded-bl-sm'
                  }`}
                >
                  {msg.role === 'assistant' ? (
                    <ChatMessageRenderer content={msg.content} isUser={false} />
                  ) : (
                    msg.content
                  )}
                </div>
                {/* Attachment chips — shown below assistant bubbles when emails had attachments */}
                {msg.role === 'assistant' && msg.attachments && msg.attachments.length > 0 && (
                  <div className="max-w-[88%] mt-1 space-y-1">
                    {msg.attachments.map((group) => (
                      <div key={group.messageId}>
                        {group.subject && (
                          <p className="text-[9px] text-slate-400 mb-0.5 truncate">
                            📎 {group.subject}
                          </p>
                        )}
                        <AttachmentRow
                          messageId={group.messageId}
                          attachments={group.attachments}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {chatMutation.isPending && (
              <div className="flex justify-start">
                <div className="bg-slate-100 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            )}

            {messages.length === 1 && !chatMutation.isPending && (
              <div className="space-y-1.5 pt-1">
                <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">Try asking:</p>
                {SUGGESTED_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => send(q)}
                    className="w-full text-left text-xs text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg px-3 py-2 transition-colors border border-rose-100"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          <div className="px-3 py-3 border-t border-slate-100">
            <div className="flex items-center gap-2 bg-slate-50 rounded-xl border border-slate-200 px-3 py-2 focus-within:border-rose-400 focus-within:ring-1 focus-within:ring-rose-400 transition-all">
              <input
                ref={inputRef}
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about vendors, invoices, follow-ups…"
                disabled={chatMutation.isPending}
                className="flex-1 text-sm bg-transparent focus:outline-none text-slate-800 placeholder-slate-400 disabled:opacity-50"
              />
              <button
                onClick={() => send()}
                disabled={!draft.trim() || chatMutation.isPending}
                className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
              Answers are grounded in your actual Gmail inbox
            </p>
          </div>
        </div>
      )}
    </>
  );
}
