/**
 * AttachmentChip — renders a clickable chip for a Gmail attachment.
 *
 * On click it calls GET /gmail/attachment?messageId=X&attachmentId=Y,
 * decodes the base64url response, and triggers a browser download.
 * No third-party deps — uses the native File/Blob/URL APIs.
 */

import { useState } from 'react';
import { Download, FileText, Image, FileSpreadsheet, File, Loader2 } from 'lucide-react';
import api from '../lib/api';

export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

interface Props {
  messageId: string;
  attachment: AttachmentMeta;
  /** Optional extra class names on the chip wrapper */
  className?: string;
}

/** Pick a Lucide icon based on MIME type. */
function AttachIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType.startsWith('image/')) return <Image className={className} />;
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType === 'text/csv')
    return <FileSpreadsheet className={className} />;
  if (mimeType.includes('pdf') || mimeType.includes('word') || mimeType.includes('document'))
    return <FileText className={className} />;
  return <File className={className} />;
}

function fmtSize(bytes: number): string {
  if (bytes === 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Convert base64url → Uint8Array */
function base64UrlToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export default function AttachmentChip({ messageId, attachment, className }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const res = await api.get<{ data: string; filename: string; size: number }>(
        '/gmail/attachment',
        {
          params: {
            messageId,
            attachmentId: attachment.attachmentId,
            filename: attachment.filename,
          },
        }
      );
      const bytes = base64UrlToBytes(res.data.data);
      const blob = new Blob([bytes as unknown as BlobPart], { type: attachment.mimeType || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = attachment.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        (err as Error).message;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleDownload()}
      disabled={loading}
      title={error ?? `Download ${attachment.filename}`}
      className={`inline-flex items-center gap-1.5 text-[11px] rounded-lg border px-2 py-1 transition-all
        ${error
          ? 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100'
          : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-blue-50 hover:border-blue-200 hover:text-blue-700'
        }
        disabled:opacity-60 disabled:cursor-not-allowed
        ${className ?? ''}
      `}
    >
      {loading ? (
        <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
      ) : (
        <AttachIcon mimeType={attachment.mimeType} className="w-3 h-3 flex-shrink-0" />
      )}
      <span className="truncate max-w-[160px]">{attachment.filename}</span>
      {attachment.size > 0 && (
        <span className="text-[9px] text-slate-400 flex-shrink-0">{fmtSize(attachment.size)}</span>
      )}
      {!loading && !error && (
        <Download className="w-2.5 h-2.5 flex-shrink-0 opacity-50" />
      )}
    </button>
  );
}

/**
 * Renders a row of AttachmentChips for a list of attachments.
 * Used in both GmailAnalysis cards and GmailChat bubbles.
 */
export function AttachmentRow({
  messageId,
  attachments,
  className,
}: {
  messageId: string;
  attachments: AttachmentMeta[];
  className?: string;
}) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1.5 mt-1.5 ${className ?? ''}`}>
      {attachments.map((a) => (
        <AttachmentChip
          key={a.attachmentId}
          messageId={messageId}
          attachment={a}
        />
      ))}
    </div>
  );
}
