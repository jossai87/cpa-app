/**
 * SourceAccountBadge — tiny pill showing which Gmail inbox an item came from.
 *
 * Only renders when `sourceAccount` is set and is NOT the primary account
 * ('flowermound'). Primary-account items show nothing — they're the default.
 *
 * Visible only to admins (jandoossai@gmail.com) since the second inbox
 * data is admin-only.
 */

import { useAdmin } from '../lib/admin';

const ACCOUNT_LABELS: Record<string, string> = {
  nancy: 'nancyandjustin@',
};

export default function SourceAccountBadge({
  sourceAccount,
}: {
  sourceAccount?: string;
}) {
  const { isAdmin } = useAdmin();

  // Only show for non-primary accounts, and only to admins.
  if (!sourceAccount || sourceAccount === 'flowermound') return null;
  if (!isAdmin) return null;

  const label = ACCOUNT_LABELS[sourceAccount] ?? sourceAccount;

  return (
    <span
      className="inline-flex items-center text-[9px] font-medium px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 border border-purple-200 ml-1 align-middle"
      title={`From ${label} inbox`}
    >
      📬 {label}
    </span>
  );
}
