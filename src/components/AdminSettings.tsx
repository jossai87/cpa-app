/**
 * Admin Settings panel — visible only to the owner (ADMIN_EMAIL).
 *
 * Three sections accessible via tabs:
 *   1. Visibility  — show/hide features for non-admin users
 *   2. Daily Target — tune the daily sales target for briefing emails
 *   3. Integrations — view and update API keys for Heartland + Gmail
 */

import { useState, useEffect } from 'react';
import { X, ShieldCheck, Loader2, Target, Plug, Eye, EyeOff, Check, AlertCircle } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAdmin } from '../lib/admin';
import api from '../lib/api';

// ── Types ─────────────────────────────────────────────────────────────

interface IntegrationField {
  key: string;
  label: string;
  value: string;
  sensitive: boolean;
  hint?: string;
  readOnly?: boolean;
}

interface Integration {
  id: string;
  name: string;
  description: string;
  logoEmoji: string;
  docsUrl?: string;
  fields: IntegrationField[];
}

// ── Integrations section ──────────────────────────────────────────────

function IntegrationsSection() {
  const queryClient = useQueryClient();

  const integrationsQ = useQuery<{ integrations: Integration[] }>({
    queryKey: ['integrations'],
    queryFn: () => api.get<{ integrations: Integration[] }>('/integrations').then((r) => r.data),
    staleTime: 60 * 1000,
  });

  const updateMut = useMutation({
    mutationFn: ({ id, fields }: { id: string; fields: Record<string, string> }) =>
      api.put(`/integrations/${id}`, fields).then((r) => r.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
  });

  // Per-integration edit state: { [integrationId]: { [fieldKey]: draftValue } }
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [showValues, setShowValues] = useState<Record<string, boolean>>({});
  const [saveStatus, setSaveStatus] = useState<Record<string, 'idle' | 'saving' | 'saved' | 'error'>>({});

  function setDraft(integrationId: string, fieldKey: string, value: string) {
    setDrafts((prev) => ({
      ...prev,
      [integrationId]: { ...(prev[integrationId] ?? {}), [fieldKey]: value },
    }));
  }

  function getDraft(integrationId: string, fieldKey: string, fallback: string): string {
    return drafts[integrationId]?.[fieldKey] ?? fallback;
  }

  async function saveIntegration(integration: Integration) {
    const changed: Record<string, string> = {};
    for (const f of integration.fields) {
      if (f.readOnly) continue;
      const draft = drafts[integration.id]?.[f.key];
      // Only include fields that were actually edited (non-empty draft that differs from masked value)
      if (draft !== undefined && draft.trim() !== '' && !draft.includes('••')) {
        changed[f.key] = draft.trim();
      }
    }
    if (Object.keys(changed).length === 0) return;

    setSaveStatus((s) => ({ ...s, [integration.id]: 'saving' }));
    try {
      await updateMut.mutateAsync({ id: integration.id, fields: changed });
      // Clear drafts for this integration after save
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[integration.id];
        return next;
      });
      setSaveStatus((s) => ({ ...s, [integration.id]: 'saved' }));
      setTimeout(() => setSaveStatus((s) => ({ ...s, [integration.id]: 'idle' })), 2500);
    } catch {
      setSaveStatus((s) => ({ ...s, [integration.id]: 'error' }));
      setTimeout(() => setSaveStatus((s) => ({ ...s, [integration.id]: 'idle' })), 3000);
    }
  }

  if (integrationsQ.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500 py-4">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading integrations…
      </div>
    );
  }

  if (integrationsQ.isError) {
    return (
      <div className="flex items-center gap-2 text-sm text-red-600 py-4">
        <AlertCircle className="w-4 h-4" /> Failed to load integrations.
      </div>
    );
  }

  const integrations = integrationsQ.data?.integrations ?? [];

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-500">
        API keys and credentials for external integrations. Values are stored in AWS Secrets Manager.
        Sensitive fields are masked — type a new value to update.
      </p>
      {integrations.map((integration) => {
        const status = saveStatus[integration.id] ?? 'idle';
        return (
          <div key={integration.id} className="border border-slate-200 rounded-lg overflow-hidden">
            {/* Integration header */}
            <div className="bg-slate-50 px-4 py-3 flex items-start justify-between gap-3 border-b border-slate-200">
              <div className="flex items-start gap-2.5 min-w-0">
                <span className="text-xl flex-shrink-0">{integration.logoEmoji}</span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900">{integration.name}</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">{integration.description}</p>
                </div>
              </div>
              {integration.docsUrl && (
                <a
                  href={integration.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-blue-600 hover:underline flex-shrink-0"
                >
                  Docs ↗
                </a>
              )}
            </div>

            {/* Fields */}
            <div className="px-4 py-3 space-y-3">
              {integration.fields.map((field) => {
                const showKey = `${integration.id}:${field.key}`;
                const isVisible = showValues[showKey] ?? false;
                const draft = getDraft(integration.id, field.key, field.value);
                const isEdited = drafts[integration.id]?.[field.key] !== undefined &&
                  !drafts[integration.id]?.[field.key]?.includes('••');

                return (
                  <div key={field.key}>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[11px] font-medium text-slate-600">{field.label}</label>
                      {field.sensitive && !field.readOnly && (
                        <button
                          type="button"
                          onClick={() => setShowValues((s) => ({ ...s, [showKey]: !isVisible }))}
                          className="text-[10px] text-slate-400 hover:text-slate-600 flex items-center gap-0.5"
                        >
                          {isVisible ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                          {isVisible ? 'Hide' : 'Show'}
                        </button>
                      )}
                    </div>
                    <input
                      type={field.sensitive && !isVisible ? 'password' : 'text'}
                      value={draft}
                      readOnly={field.readOnly}
                      onChange={(e) => !field.readOnly && setDraft(integration.id, field.key, e.target.value)}
                      placeholder={field.sensitive ? 'Enter new value to update…' : ''}
                      className={`w-full text-xs rounded-md border px-3 py-1.5 font-mono focus:outline-none focus:ring-1 transition ${
                        field.readOnly
                          ? 'bg-slate-50 border-slate-200 text-slate-500 cursor-default'
                          : isEdited
                            ? 'border-blue-300 bg-blue-50 focus:ring-blue-400 text-slate-800'
                            : 'border-slate-300 bg-white focus:ring-blue-400 text-slate-700'
                      }`}
                    />
                    {field.hint && (
                      <p className="text-[10px] text-slate-400 mt-0.5">{field.hint}</p>
                    )}
                  </div>
                );
              })}

              {/* Save button */}
              <div className="flex items-center justify-between pt-1">
                <div className="text-[11px]">
                  {status === 'saved' && (
                    <span className="text-emerald-600 flex items-center gap-1">
                      <Check className="w-3 h-3" /> Saved
                    </span>
                  )}
                  {status === 'error' && (
                    <span className="text-red-600 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" /> Save failed
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void saveIntegration(integration)}
                  disabled={status === 'saving' || !Object.values(drafts[integration.id] ?? {}).some(
                    (v) => v.trim() !== '' && !v.includes('••')
                  )}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  {status === 'saving' ? (
                    <><Loader2 className="w-3 h-3 animate-spin" /> Saving…</>
                  ) : (
                    'Save changes'
                  )}
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────

type AdminTab = 'target' | 'integrations';

export default function AdminSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { isAdmin, dailyTarget, isLoading, isSaving, updateDailyTarget } = useAdmin();
  const [targetDraft, setTargetDraft] = useState(String(dailyTarget));
  const [activeTab, setActiveTab] = useState<AdminTab>('target');

  useEffect(() => { setTargetDraft(String(dailyTarget)); }, [dailyTarget]);

  if (!open || !isAdmin) return null;

  function handleSaveTarget() {
    const n = parseFloat(targetDraft);
    if (Number.isFinite(n) && n >= 0) updateDailyTarget(n);
  }

  const tabs: Array<{ id: AdminTab; label: string; icon: React.ElementType }> = [
    { id: 'target', label: 'Daily Target', icon: Target },
    { id: 'integrations', label: 'Integrations', icon: Plug },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-blue-600" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">Admin Settings</h2>
              <p className="text-xs text-slate-500 mt-0.5">Owner-only controls for visibility, targets, and integrations.</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-slate-200 px-6">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
                activeTab === t.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300'
              }`}
            >
              <t.icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {isLoading && activeTab !== 'integrations' ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading settings…
            </div>
          ) : activeTab === 'target' ? (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <Target className="w-4 h-4 text-blue-600" />
                <h3 className="text-sm font-semibold text-blue-900">Daily Sales Target</h3>
              </div>
              <p className="text-xs text-slate-600 mb-3">
                Used by the daily 10 PM briefing email to show whether the store hit its target.
              </p>
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-600">$</span>
                <input
                  type="number"
                  min={0}
                  step="50"
                  value={targetDraft}
                  onChange={(e) => setTargetDraft(e.target.value)}
                  onBlur={handleSaveTarget}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSaveTarget(); } }}
                  className="flex-1 text-sm border border-blue-300 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
                />
                <span className="text-xs text-slate-500">per day</span>
              </div>
            </div>
          ) : (
            <IntegrationsSection />
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-100 flex items-center justify-between">
          <p className="text-[11px] text-slate-400">
            {isSaving && <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Saving…</span>}
            {!isSaving && activeTab !== 'integrations' && 'Changes save automatically.'}
            {activeTab === 'integrations' && 'Keys stored in AWS Secrets Manager.'}
          </p>
          <button onClick={onClose} className="px-4 py-1.5 text-sm rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
