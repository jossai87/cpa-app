/**
 * EmailFeed — right-side panel on the Foot Solutions Management Screen
 * showing the history of daily briefing emails sent to the owner.
 *
 * Click any row to expand and view the full HTML body inline.
 * Admin can also trigger a test email (manual run of the daily-report Lambda).
 */

import { useState } from 'react';
import { Mail, Send, Loader2, ChevronDown, AlertCircle } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import { useAdmin } from '../lib/admin';

interface EmailRecord {
  date: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  status: 'beat' | 'miss' | 'pace' | 'none';
  sendStatus: 'sent' | 'failed';
  sendError: string | null;
  generatedAt: string;
}

const statusBadge: Record<EmailRecord['status'], { label: string; cls: string }> = {
  beat: { label: '🎯 Beat', cls: 'bg-emerald-100 text-emerald-700' },
  miss: { label: '⚠️ Missed', cls: 'bg-red-100 text-red-700' },
  pace: { label: '✓ On pace', cls: 'bg-blue-100 text-blue-700' },
  none: { label: 'No sales', cls: 'bg-slate-100 text-slate-600' },
};

export default function EmailFeed() {
  const { isAdmin } = useAdmin();
  const [expanded, setExpanded] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const emailsQ = useQuery<{ emails: EmailRecord[] }>({
    queryKey: ['admin', 'emails'],
    queryFn: () => api.get<{ emails: EmailRecord[] }>('/admin/emails?limit=30').then((r) => r.data),
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000, // refresh every 5 min
  });

  const testMutation = useMutation({
    mutationFn: () => api.post('/admin/test-email').then((r) => r.data),
    onSuccess: () => {
      // Refetch after a delay to give the Lambda time to write the new email
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ['admin', 'emails'] });
      }, 8_000);
    },
  });

  const emails = emailsQ.data?.emails ?? [];

  return (
    <aside className="bg-white rounded-xl border border-slate-200 overflow-hidden flex flex-col" style={{ maxHeight: 'calc(100vh - 180px)' }}>
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
        <Mail className="w-4 h-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-slate-900 flex-1">Daily Briefings</h3>
        {isAdmin && (
          <button
            onClick={() => testMutation.mutate()}
            disabled={testMutation.isPending}
            title="Trigger a test email now"
            className="flex items-center gap-1 text-[10px] px-2 py-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50 transition"
          >
            {testMutation.isPending
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <Send className="w-3 h-3" />
            }
            Send test
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {emailsQ.isLoading && (
          <div className="p-6 flex items-center justify-center text-sm text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading…
          </div>
        )}
        {emailsQ.isError && (
          <div className="p-4 text-xs text-red-600 flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>Failed to load briefings.</span>
          </div>
        )}
        {!emailsQ.isLoading && emails.length === 0 && (
          <div className="p-6 text-center">
            <Mail className="w-6 h-6 text-slate-300 mx-auto mb-2" />
            <p className="text-xs text-slate-500">No briefings yet.</p>
            <p className="text-[10px] text-slate-400 mt-1">First email arrives at 10 PM Central tonight.</p>
          </div>
        )}
        {emails.map((e) => {
          const isExpanded = expanded === e.date;
          const badge = statusBadge[e.status] ?? statusBadge.pace;
          const dateLabel = new Date(e.date + 'T12:00:00').toLocaleDateString('en-US', {
            timeZone: 'America/Chicago', month: 'short', day: 'numeric',
          });
          const generatedTime = new Date(e.generatedAt).toLocaleTimeString('en-US', {
            timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit',
          });
          return (
            <div key={e.date} className="border-b border-slate-100 last:border-0">
              <button
                onClick={() => setExpanded(isExpanded ? null : e.date)}
                className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-2 transition"
              >
                <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-slate-700">{dateLabel}</span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold ${badge.cls}`}>{badge.label}</span>
                    {e.sendStatus === 'failed' && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold">Send failed</span>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-400 mt-0.5">Sent {generatedTime}</p>
                </div>
              </button>
              {isExpanded && (
                <div className="px-4 pb-3 bg-slate-50">
                  {e.sendError && (
                    <div className="mb-2 text-[11px] text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
                      Error: {e.sendError}
                    </div>
                  )}
                  <div className="bg-white rounded border border-slate-200 p-3 text-xs leading-relaxed text-slate-700 whitespace-pre-wrap font-mono">
                    {e.bodyText}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
