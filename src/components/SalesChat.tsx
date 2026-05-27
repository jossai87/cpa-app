/**
 * SalesChat — floating AI chatbot for the Sales & Revenue page.
 *
 * Renders a message bubble in the bottom-right corner.
 * Opens a chat panel backed by POST /pos/chat (Bedrock Nova 2 Lite).
 * Only mounted inside SalesRevenue.tsx so it never appears elsewhere.
 */

import { useState, useRef, useEffect } from 'react';
import { MessageCircle, X, Send, Loader2, Bot } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import api from '../lib/api';
import ChatMessageRenderer from './ChatMessageRenderer';
import ChatHistory, { useChatHistory, type HistoryMessage } from './ChatHistory';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatResponse {
  reply: string;
}

const SUGGESTED_QUESTIONS = [
  "What were today's sales?",
  "Which brand has the highest YTD net sales?",
  "How many low-stock items do we have?",
  "Who is the top performing staff member this month?",
  "What are our open purchase orders?",
];

export default function SalesChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: "Hi! I'm your Sales & Revenue assistant. Ask me anything about today's sales, inventory, staff performance, purchasing, or brand trends.",
    },
  ]);
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { save, resetSession } = useChatHistory('sales');

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when panel opens
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 100);
  }, [open]);

  const chatMutation = useMutation({
    mutationFn: (msgs: ChatMessage[]) =>
      api.post<ChatResponse>('/pos/chat', { messages: msgs }).then(r => r.data),
    onSuccess: (data, vars) => {
      const newMsg: ChatMessage = { role: 'assistant', content: data.reply };
      const updated = [...vars, newMsg];
      setMessages(updated);
      // Auto-save the full conversation (skip the initial greeting at index 0)
      const toSave = updated.slice(1); // drop the initial "Hi! I'm your..." greeting
      if (toSave.length >= 2) void save(toSave);
    },
    onError: () => {
      setMessages(prev => [
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
    // Send full conversation history for multi-turn context
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
      content: "Hi! I'm your Sales & Revenue assistant. Ask me anything about today's sales, inventory, staff performance, purchasing, or brand trends.",
    }]);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  return (
    <>
      {/* ── Floating bubble ── */}
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={open ? 'Close chat' : 'Open AI assistant'}
        className={`fixed bottom-6 right-6 z-50 flex items-center justify-center w-14 h-14 rounded-full shadow-lg transition-all duration-200 ${
          open
            ? 'bg-slate-700 hover:bg-slate-800'
            : 'bg-blue-600 hover:bg-blue-700'
        }`}
      >
        {open
          ? <X className="w-6 h-6 text-white" />
          : <MessageCircle className="w-6 h-6 text-white" />
        }
        {/* Unread dot — only when closed and there's a pending response */}
        {!open && chatMutation.isPending && (
          <span className="absolute top-1 right-1 w-3 h-3 rounded-full bg-amber-400 animate-pulse" />
        )}
      </button>

      {/* ── Chat panel ── */}
      {open && (
        <div
          className="fixed bottom-24 right-6 z-50 flex flex-col bg-white rounded-2xl shadow-2xl border border-slate-200 w-[360px] max-w-[calc(100vw-2rem)]"
          style={{ height: '520px' }}
        >
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-100 rounded-t-2xl bg-blue-600">
            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-white/20">
              <Bot className="w-4 h-4 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white leading-tight">Sales Assistant</p>
              <p className="text-[10px] text-blue-200">Powered by Amazon Bedrock · Live store data</p>
            </div>
            <div className="flex items-center gap-2">
              <ChatHistory type="sales" onLoadSession={loadFromHistory} accentClass="bg-blue-600" />
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

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white rounded-br-sm'
                      : 'bg-slate-100 text-slate-800 rounded-bl-sm'
                  }`}
                >
                  {msg.role === 'assistant' ? (
                    <ChatMessageRenderer content={msg.content} isUser={false} />
                  ) : (
                    msg.content
                  )}
                </div>
              </div>
            ))}

            {/* Typing indicator */}
            {chatMutation.isPending && (
              <div className="flex justify-start">
                <div className="bg-slate-100 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            )}

            {/* Suggested questions — only on first message */}
            {messages.length === 1 && !chatMutation.isPending && (
              <div className="space-y-1.5 pt-1">
                <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">Try asking:</p>
                {SUGGESTED_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => send(q)}
                    className="w-full text-left text-xs text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg px-3 py-2 transition-colors border border-blue-100"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="px-3 py-3 border-t border-slate-100">
            <div className="flex items-center gap-2 bg-slate-50 rounded-xl border border-slate-200 px-3 py-2 focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-400 transition-all">
              <input
                ref={inputRef}
                type="text"
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about sales, inventory, staff…"
                disabled={chatMutation.isPending}
                className="flex-1 text-sm bg-transparent focus:outline-none text-slate-800 placeholder-slate-400 disabled:opacity-50"
              />
              <button
                onClick={() => send()}
                disabled={!draft.trim() || chatMutation.isPending}
                className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                aria-label="Send"
              >
                {chatMutation.isPending
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Send className="w-3.5 h-3.5" />
                }
              </button>
            </div>
            <p className="text-[9px] text-slate-400 text-center mt-1.5">
              Answers are based on your live Heartland POS data
            </p>
          </div>
        </div>
      )}
    </>
  );
}
