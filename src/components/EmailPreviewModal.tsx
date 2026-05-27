/**
 * EmailPreviewModal — shows the rendered campaign email exactly as a
 * recipient would see it. Runs in an iframe (srcDoc) so the email's
 * inline styles can't leak into the host app and vice versa.
 *
 * Includes a fake "envelope" header (subject / from / reply-to) for
 * extra realism, plus desktop/mobile width toggles.
 */

import { useState } from 'react';
import { X, Monitor, Smartphone, Type, User } from 'lucide-react';
import { buildCampaignPreviewHtml } from '../lib/campaignPreview';

interface Props {
  subject: string;
  bodyHtml: string;
  /**
   * Initial sample first-name used in greeting. Defaults to "Kathy".
   * Real sends always use each recipient's actual first name.
   */
  sampleFirstName?: string;
  onClose: () => void;
}

// A small set of representative first names so the admin can see the
// greeting render with different name lengths / styles. Doesn't change
// any actual recipient data — purely visual.
const SAMPLE_NAMES = ['Kathy', 'Wayne', "O'Donnell", 'Mary-Anne', '(empty)'] as const;

export default function EmailPreviewModal({
  subject,
  bodyHtml,
  sampleFirstName = 'Kathy',
  onClose,
}: Props) {
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [previewName, setPreviewName] = useState<string>(sampleFirstName);

  const html = buildCampaignPreviewHtml({
    bodyHtml:
      bodyHtml ||
      '<p style="color:#94a3b8;font-style:italic">(empty body — type something or pick a template)</p>',
    recipientName: previewName === '(empty)' ? '' : previewName,
  });

  const iframeWidth = device === 'desktop' ? 720 : 380;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-slate-900/60 backdrop-blur-sm overflow-y-auto p-4 sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full flex flex-col my-auto"
        style={{ maxWidth: 820, maxHeight: 'calc(100vh - 3rem)' }}
      >
        {/* Header */}
        <div className="flex-shrink-0 flex items-center justify-between gap-3 px-5 py-3 border-b border-slate-200">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900">
              Email preview
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Renders the same HTML recipients see — header + body + footer.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Device toggle */}
            <div className="inline-flex items-center bg-slate-100 rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => setDevice('desktop')}
                title="Desktop width"
                className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-md transition ${
                  device === 'desktop'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <Monitor className="w-3 h-3" />
                Desktop
              </button>
              <button
                type="button"
                onClick={() => setDevice('mobile')}
                title="Mobile width"
                className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-md transition ${
                  device === 'mobile'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <Smartphone className="w-3 h-3" />
                Mobile
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg p-1.5"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Envelope header (subject / from / reply-to) */}
        <div className="flex-shrink-0 px-5 py-3 border-b border-slate-100 bg-slate-50 text-xs space-y-1">
          <div className="flex items-baseline gap-2">
            <span className="text-slate-400 w-16 flex-shrink-0">From</span>
            <span className="text-slate-700">
              Foot Solutions Flower Mound{' '}
              <span className="text-slate-400">
                &lt;notifications@fsmanagementsystem.com&gt;
              </span>
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-slate-400 w-16 flex-shrink-0">Reply-to</span>
            <span className="text-slate-700">flowermound@footsolutions.com</span>
          </div>
          <div className="flex items-baseline gap-2">
            <Type className="w-3 h-3 text-slate-400 flex-shrink-0" aria-hidden />
            <span className="text-slate-400 w-[52px] flex-shrink-0">Subject</span>
            <span className="text-slate-900 font-medium truncate">
              {subject || (
                <span className="text-slate-400 italic font-normal">
                  (no subject)
                </span>
              )}
            </span>
          </div>
        </div>

        {/* Sample-recipient picker — actual sends use each customer's real name */}
        <div className="flex-shrink-0 px-5 py-2 border-b border-slate-100 bg-white flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-slate-500 inline-flex items-center gap-1">
            <User className="w-3 h-3" />
            Greeting preview as
          </span>
          {SAMPLE_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setPreviewName(name)}
              className={`text-[11px] px-2 py-0.5 rounded-full border transition ${
                previewName === name
                  ? 'border-indigo-300 bg-indigo-50 text-indigo-800 font-medium'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {name}
            </button>
          ))}
          <span className="text-[10px] text-slate-400 ml-auto">
            Real sends use each recipient's actual first name.
          </span>
        </div>

        {/* Iframe rendering the actual email HTML */}
        <div className="flex-1 overflow-y-auto bg-slate-100 p-4 sm:p-6 flex justify-center">
          <iframe
            title="Campaign email preview"
            srcDoc={html}
            sandbox="allow-same-origin"
            style={{
              width: iframeWidth,
              maxWidth: '100%',
              height: 'min(70vh, 800px)',
              border: 'none',
              borderRadius: 8,
              background: '#f8fafc',
              boxShadow: '0 4px 16px rgba(15,23,42,0.08)',
              transition: 'width 200ms ease',
            }}
          />
        </div>

        {/* Footer hint */}
        <div className="flex-shrink-0 px-5 py-2.5 border-t border-slate-200 bg-slate-50 text-[11px] text-slate-500 text-center">
          Each recipient sees their own first name in the greeting (auto-pulled
          from Heartland and title-cased). The unsubscribe link is generated
          per recipient at send time.
        </div>
      </div>
    </div>
  );
}
