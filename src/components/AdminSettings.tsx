/**
 * Admin Settings panel — visible only to the owner (ADMIN_EMAIL).
 * Lets the admin show/hide features for everyone else, and tune the
 * daily sales target used by the daily briefing email.
 */

import { useState, useEffect } from 'react';
import { X, ShieldCheck, Loader2, Target } from 'lucide-react';
import { useAdmin, VISIBILITY_KEYS, type VisibilityKey } from '../lib/admin';

export default function AdminSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { isAdmin, overrides, dailyTarget, isLoading, isSaving, updateVisibility, resetVisibility, updateDailyTarget } = useAdmin();
  const [targetDraft, setTargetDraft] = useState(String(dailyTarget));

  // Sync draft with server value when it changes
  useEffect(() => { setTargetDraft(String(dailyTarget)); }, [dailyTarget]);

  if (!open || !isAdmin) return null;

  const keys = Object.keys(VISIBILITY_KEYS) as VisibilityKey[];

  function handleSaveTarget() {
    const n = parseFloat(targetDraft);
    if (Number.isFinite(n) && n >= 0) updateDailyTarget(n);
  }

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
              <p className="text-xs text-slate-500 mt-0.5">Control visibility and tune the daily briefing target.</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading settings…
            </div>
          ) : (
            <>
              {/* Daily target section */}
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

              {/* Visibility section */}
              <div>
                <h3 className="text-sm font-semibold text-slate-900 mb-2">Feature Visibility (non-admin users)</h3>
                <div className="space-y-2">
                  {keys.map((key) => {
                    const meta = VISIBILITY_KEYS[key];
                    const override = overrides[key];
                    const state: 'show' | 'hide' | 'default' =
                      override === true ? 'show' :
                      override === false ? 'hide' :
                      'default';

                    return (
                      <div key={key} className="flex items-center justify-between gap-4 bg-slate-50 rounded-lg px-3 py-2.5 border border-slate-100">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-slate-800 truncate">{meta.label}</p>
                          <p className="text-[10px] text-slate-400 font-mono">{key}</p>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button
                            onClick={() => updateVisibility(key, true)}
                            disabled={isSaving}
                            className={`px-2.5 py-1 text-xs rounded-md border transition ${state === 'show' ? 'bg-emerald-100 border-emerald-300 text-emerald-700 font-medium' : 'border-slate-200 text-slate-500 hover:bg-slate-100'}`}
                          >
                            Show
                          </button>
                          <button
                            onClick={() => updateVisibility(key, false)}
                            disabled={isSaving}
                            className={`px-2.5 py-1 text-xs rounded-md border transition ${state === 'hide' ? 'bg-red-100 border-red-300 text-red-700 font-medium' : 'border-slate-200 text-slate-500 hover:bg-slate-100'}`}
                          >
                            Hide
                          </button>
                          <button
                            onClick={() => resetVisibility(key)}
                            disabled={isSaving}
                            className={`px-2.5 py-1 text-xs rounded-md border transition ${state === 'default' ? 'bg-slate-200 border-slate-300 text-slate-700 font-medium' : 'border-slate-200 text-slate-500 hover:bg-slate-100'}`}
                            title={`Default: ${meta.defaultVisible ? 'visible' : 'hidden'}`}
                          >
                            Default
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-100 flex items-center justify-between">
          <p className="text-[11px] text-slate-400">
            {isSaving && <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Saving…</span>}
            {!isSaving && 'Changes save automatically.'}
          </p>
          <button onClick={onClose} className="px-4 py-1.5 text-sm rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
