import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, Trash2 } from 'lucide-react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import api from '../lib/api';
import TaxForm, { TaxFormHandle } from '../components/TaxForm';
import TaxResult from '../components/TaxResult';
import TaxHistoryList from '../components/TaxHistoryList';
import DocumentsSidebar from '../components/DocumentsSidebar';
import CpaPackage from '../components/CpaPackage';
import CentralTimeBadge from '../components/CentralTimeBadge';
import Spinner from '../components/Spinner';
import { useDocuments, useDeleteAllDocuments } from '../hooks/useDocuments';
import type { TaxFormData, TaxSession } from '../types';

export default function CpaTaxAssistant() {
  const queryClient = useQueryClient();
  const [activeSession, setActiveSession] = useState<TaxSession | null>(null);
  // Session selected from history — shown inline below the history table
  const [historySession, setHistorySession] = useState<TaxSession | null>(null);
  // Tracks the in-flight async analysis. While set, the page polls
  // GET /tax/history/{id} until status is 'complete' or 'error'.
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [hydrationMsg, setHydrationMsg] = useState<string | null>(null);
  const [resetState, setResetState] = useState<
    'idle' | 'confirming' | 'resetting' | 'done' | 'error'
  >('idle');
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const formRef = useRef<TaxFormHandle>(null);
  const didHydrateRef = useRef(false);

  const { data: documents } = useDocuments();
  const deleteAllMut = useDeleteAllDocuments();

  // POST /tax/calculate now returns 202 immediately with { sessionId, status:'pending' }.
  // We capture the sessionId and start polling below.
  const calculateMutation = useMutation({
    mutationFn: (formData: TaxFormData) =>
      api.post<TaxSession>('/tax/calculate', formData).then((r) => r.data),
    onSuccess: (data) => {
      // Show the pending session in the result panel so the spinner has context
      setActiveSession(data);
      setPendingSessionId(data.sessionId);
      // Clear the draft on success so the form resets for the next session
      formRef.current?.clearDraft();
      // Allow hydration again for the next analysis cycle
      didHydrateRef.current = false;
      void queryClient.invalidateQueries({ queryKey: ['tax', 'history'] });
    },
  });

  // Poll the pending session until the backend marks it complete or errored.
  // Stops automatically when pendingSessionId is null.
  const pollingQuery = useQuery<TaxSession>({
    queryKey: ['tax', 'session', pendingSessionId],
    queryFn: () =>
      api
        .get<TaxSession>(`/tax/history/${pendingSessionId}`)
        .then((r) => r.data),
    enabled: !!pendingSessionId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'complete' || status === 'error') return false;
      return 2500; // poll every 2.5s while pending
    },
    refetchIntervalInBackground: false,
  });

  // When polling resolves, hydrate the active session and stop polling.
  useEffect(() => {
    const polled = pollingQuery.data;
    if (!polled || !pendingSessionId) return;
    if (polled.status === 'complete' || polled.status === 'error') {
      setActiveSession(polled);
      setPendingSessionId(null);
      void queryClient.invalidateQueries({ queryKey: ['tax', 'history'] });
    }
  }, [pollingQuery.data, pendingSessionId, queryClient]);

  // Build per-field provenance from persisted documents:
  //   { fieldName: [{ fileName, amount, confidence }, ...] }
  // Each doc that contributed a positive amount to a field is listed.
  // Used by the form to render a small caption + confidence badge under each
  // input showing which uploads filled it in.
  const fieldProvenance = (() => {
    if (!documents || documents.length === 0) return undefined;
    const map: Record<
      string,
      Array<{
        fileName: string;
        amount: number;
        confidence: 'high' | 'medium' | 'low';
      }>
    > = {};
    for (const doc of documents) {
      const conf =
        doc.confidence === 'high' ||
        doc.confidence === 'medium' ||
        doc.confidence === 'low'
          ? doc.confidence
          : 'medium';
      for (const [field, amount] of Object.entries(doc.appliedTotals ?? {})) {
        if (typeof amount !== 'number' || amount <= 0) continue;
        if (!map[field]) map[field] = [];
        map[field]!.push({ fileName: doc.fileName, amount, confidence: conf });
      }
    }
    return map;
  })();

  // Once documents finish loading on first page visit, sum their applied totals
  // and seed the form. Only fields the user hasn't already filled get touched.
  useEffect(() => {
    if (didHydrateRef.current) return;
    if (!documents || !formRef.current) return;
    if (documents.length === 0) {
      didHydrateRef.current = true;
      return;
    }

    // Sum appliedTotals across all docs
    const summed: Record<string, number> = {};
    for (const doc of documents) {
      for (const [k, v] of Object.entries(doc.appliedTotals ?? {})) {
        if (typeof v === 'number' && v > 0) {
          summed[k] = (summed[k] ?? 0) + v;
        }
      }
    }

    const filled = formRef.current.hydrateFromDocuments(summed);
    didHydrateRef.current = true;
    if (filled > 0) {
      setHydrationMsg(
        `Pre-filled ${filled} field${filled === 1 ? '' : 's'} from your ${documents.length} stored document${documents.length === 1 ? '' : 's'}. Existing values were left alone.`
      );
      // Auto-dismiss after 8 seconds
      const t = setTimeout(() => setHydrationMsg(null), 8000);
      return () => clearTimeout(t);
    }
  }, [documents]);

  const handleFormSubmit = (formData: TaxFormData) => {
    calculateMutation.mutate(formData);
  };

  const historyResultRef = useRef<HTMLDivElement>(null);

  const handleSelectSession = (session: TaxSession) => {
    setHistorySession(session);
    // Scroll to the result after a tick so the DOM has rendered
    setTimeout(() => {
      historyResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  // When a doc is deleted from the sidebar, subtract its applied totals from the form
  const handleDocumentDeleted = (appliedTotals: Record<string, number>) => {
    formRef.current?.subtractTotals(appliedTotals);
  };

  // When a flagged item is resolved (apply / ignore / undo), the backend returns
  // a signed delta map showing which fields changed. Push it into the form.
  const handleFlaggedResolved = (formDelta: Record<string, number>) => {
    formRef.current?.applyDelta(formDelta);
  };

  // "Reset Everything" — wipe the form draft AND delete every uploaded document.
  // Confirmation is enforced via the resetState machine so it's a 2-click action.
  async function handleConfirmReset() {
    setResetState('resetting');
    setResetMsg(null);
    try {
      const result = await deleteAllMut.mutateAsync();
      // Wipe local form state too
      formRef.current?.clearDraft();
      setActiveSession(null);
      didHydrateRef.current = true; // prevent re-hydrating from now-empty docs
      setResetState('done');
      const noun = result.deletedCount === 1 ? 'document' : 'documents';
      setResetMsg(
        `Cleared form and removed ${result.deletedCount} ${noun}.${result.s3FailureCount ? ` (${result.s3FailureCount} files could not be removed from storage but their records are gone.)` : ''}`
      );
      setTimeout(() => {
        setResetState('idle');
        setResetMsg(null);
      }, 6000);
    } catch (err) {
      const message =
        (err as { response?: { data?: { error?: string } } })?.response?.data
          ?.error ?? (err as Error).message;
      setResetState('error');
      setResetMsg(`Reset failed: ${message}`);
    }
  }

  // When a session is deleted from history, clear the result panel if it was that one
  const handleSessionDeleted = (sessionId: string) => {
    if (activeSession?.sessionId === sessionId) {
      setActiveSession(null);
    }
    if (historySession?.sessionId === sessionId) {
      setHistorySession(null);
    }
  };

  // Reload a previous session's inputs into the form so they can be edited and re-submitted
  const handleReloadSession = (session: TaxSession) => {
    if (session.inputData) {
      formRef.current?.loadInputData(session.inputData);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center gap-4">
          <Link
            to="/"
            className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900 transition-colors"
            aria-label="Back to dashboard"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            Dashboard
          </Link>
          <h1 className="text-xl font-semibold text-slate-900">CPA Tax Assistant</h1>
          <div className="ml-auto">
            <CentralTimeBadge />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex gap-6 items-start">
          {/* Main column — form + result + history */}
          <div className="flex-1 min-w-0 space-y-8">
            <section aria-labelledby="tax-form-heading">
              <div className="flex items-center justify-between mb-4">
                <h2
                  id="tax-form-heading"
                  className="text-lg font-medium text-slate-800"
                >
                  New Tax Analysis
                </h2>
                <button
                  type="button"
                  onClick={() => setResetState('confirming')}
                  className="text-xs text-slate-500 hover:text-red-600 transition flex items-center gap-1"
                  title="Clear the form and delete all uploaded documents"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Reset everything
                </button>
              </div>
              {resetMsg && resetState === 'done' && (
                <div
                  role="status"
                  className="mb-4 rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800 flex items-start justify-between gap-3"
                >
                  <span>{resetMsg}</span>
                </div>
              )}
              {resetMsg && resetState === 'error' && (
                <div
                  role="alert"
                  className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 flex items-start justify-between gap-3"
                >
                  <span>{resetMsg}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setResetState('idle');
                      setResetMsg(null);
                    }}
                    className="text-red-500 hover:text-red-700"
                    aria-label="Dismiss"
                  >
                    ×
                  </button>
                </div>
              )}
              {hydrationMsg && (
                <div
                  role="status"
                  className="mb-4 rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-800 flex items-start justify-between gap-3"
                >
                  <span>{hydrationMsg}</span>
                  <button
                    type="button"
                    onClick={() => setHydrationMsg(null)}
                    className="text-blue-500 hover:text-blue-700"
                    aria-label="Dismiss"
                  >
                    ×
                  </button>
                </div>
              )}
              <TaxForm
                ref={formRef}
                onSubmit={handleFormSubmit}
                loading={calculateMutation.isPending}
                fieldProvenance={fieldProvenance}
              />
            </section>

            {calculateMutation.isError && (
              <div
                role="alert"
                className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700"
              >
                {(calculateMutation.error as { response?: { data?: { error?: string } } })
                  ?.response?.data?.error ?? 'An unexpected error occurred. Please try again.'}
              </div>
            )}

            {(calculateMutation.isPending || pendingSessionId) && (
              <div className="flex items-center gap-3 text-sm text-slate-500">
                <Spinner size="sm" />
                {calculateMutation.isPending
                  ? 'Submitting your tax data…'
                  : 'Analyzing with Claude Sonnet 4.6 — this can take 30-90 seconds…'}
              </div>
            )}

            {activeSession?.status === 'error' && activeSession.errorMessage && (
              <div
                role="alert"
                className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700"
              >
                {activeSession.errorMessage}
              </div>
            )}

            {activeSession?.result && activeSession.status === 'complete' && (
              <section aria-labelledby="tax-result-heading">
                <h2 id="tax-result-heading" className="text-lg font-medium text-slate-800 mb-4">
                  Analysis Result
                </h2>
                <TaxResult taxYear={activeSession.taxYear} result={activeSession.result} />
              </section>
            )}

            <section aria-labelledby="cpa-package-section-heading">
              <h2
                id="cpa-package-section-heading"
                className="text-lg font-medium text-slate-800 mb-4"
              >
                Send to CPA
              </h2>
              <CpaPackage
                getFormData={() => formRef.current?.getFormData()}
                recentSession={activeSession}
                documents={documents}
              />
            </section>

            <section aria-labelledby="tax-history-heading">
              <h2 id="tax-history-heading" className="text-lg font-medium text-slate-800 mb-4">
                Session History
              </h2>
              <TaxHistoryList
                onSelectSession={handleSelectSession}
                onSessionDeleted={handleSessionDeleted}
                onReloadSession={handleReloadSession}
                selectedSessionId={historySession?.sessionId}
              />

              {/* Inline result — shown when a history row is selected */}
              {historySession && (
                <div ref={historyResultRef} className="mt-6">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-base font-medium text-slate-800">
                      Analysis — {historySession.taxYear} ({historySession.entityType})
                      <span className="ml-2 text-xs text-slate-400 font-normal">
                        {new Intl.DateTimeFormat('en-US', {
                          month: 'short', day: 'numeric', year: 'numeric',
                          hour: 'numeric', minute: '2-digit',
                        }).format(new Date(historySession.createdAt))}
                      </span>
                    </h3>
                    <button
                      type="button"
                      onClick={() => setHistorySession(null)}
                      className="text-xs text-slate-400 hover:text-slate-700 transition"
                      aria-label="Close history result"
                    >
                      ✕ Close
                    </button>
                  </div>

                  {historySession.status === 'pending' && (
                    <div className="flex items-center gap-2 text-sm text-slate-500 py-4">
                      <Spinner size="sm" /> Analysis still running…
                    </div>
                  )}
                  {historySession.status === 'error' && (
                    <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                      {historySession.errorMessage ?? 'Analysis failed.'}
                    </div>
                  )}
                  {historySession.status === 'complete' && historySession.result && (
                    <TaxResult taxYear={historySession.taxYear} result={historySession.result} />
                  )}
                </div>
              )}
            </section>
          </div>

          {/* Sidebar — uploaded documents */}
          <div className="hidden lg:block">
            <DocumentsSidebar
              onDocumentDeleted={handleDocumentDeleted}
              onFlaggedResolved={handleFlaggedResolved}
            />
          </div>
        </div>
      </main>

      {/* "Reset everything" confirmation modal */}
      {(resetState === 'confirming' || resetState === 'resetting') && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="reset-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm px-4"
        >
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-red-100 p-2 flex-shrink-0">
                <AlertTriangle className="w-5 h-5 text-red-600" />
              </div>
              <div className="flex-1">
                <h3
                  id="reset-confirm-title"
                  className="text-base font-semibold text-slate-900"
                >
                  Reset everything?
                </h3>
                <p className="text-sm text-slate-600 mt-1">
                  This will permanently delete:
                </p>
                <ul className="text-sm text-slate-600 mt-2 space-y-1 list-disc list-inside">
                  <li>
                    All <strong>{documents?.length ?? 0}</strong> uploaded
                    document{documents?.length === 1 ? '' : 's'} (metadata + S3
                    files)
                  </li>
                  <li>Every form field you've entered or auto-filled</li>
                  <li>The locally saved draft</li>
                </ul>
                <p className="text-sm text-slate-600 mt-2">
                  This <strong>can't be undone</strong>. Tax analysis sessions
                  in your history will be preserved.
                </p>
              </div>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setResetState('idle')}
                disabled={resetState === 'resetting'}
                className="px-4 py-2 text-sm rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmReset()}
                disabled={resetState === 'resetting'}
                className="px-4 py-2 text-sm rounded-md bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
              >
                {resetState === 'resetting' ? (
                  <>
                    <Spinner size="sm" />
                    Resetting…
                  </>
                ) : (
                  <>
                    <Trash2 className="w-3.5 h-3.5" />
                    Yes, reset everything
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
