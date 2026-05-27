/**
 * AccountGroupedList — renders a list of items grouped by source Gmail account.
 *
 * When items come from only one account (the common case for non-admins or
 * when the second inbox has no relevant items), renders the children flat
 * with no divider. When items span two accounts, renders a labeled
 * sub-section header between groups so the user can see at a glance which
 * inbox each item came from.
 *
 * Only admins (jandoossai@gmail.com) see the grouping — non-admins see
 * the flat list since the second inbox data is admin-only.
 *
 * Usage:
 *   <AccountGroupedList items={followUps} getAccount={(f) => f.sourceAccount}>
 *     {(item, globalIndex) => <FollowUpItem ... />}
 *   </AccountGroupedList>
 */

import { useAdmin } from '../lib/admin';

const ACCOUNT_LABELS: Record<string, { label: string; email: string; color: string }> = {
  flowermound: {
    label: 'Flower Mound',
    email: 'flowermound@footsolutions.com',
    color: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  },
  nancy: {
    label: 'Nancy & Justin',
    email: 'nancyandjustin@footsolutions.com',
    color: 'text-purple-700 bg-purple-50 border-purple-200',
  },
};

const DEFAULT_ACCOUNT = 'flowermound';

interface AccountGroupedListProps<T> {
  items: T[];
  getAccount: (item: T) => string | undefined;
  children: (item: T, globalIndex: number) => React.ReactNode;
  /** Extra class on the outer ul */
  listClassName?: string;
}

export default function AccountGroupedList<T>({
  items,
  getAccount,
  children,
  listClassName = 'space-y-3',
}: AccountGroupedListProps<T>) {
  const { isAdmin } = useAdmin();

  // Assign each item a stable global index (used for dismiss/verify keys).
  const indexed = items.map((item, i) => ({ item, globalIndex: i }));

  // Non-admins: flat list, no grouping.
  if (!isAdmin) {
    return (
      <ul className={listClassName}>
        {indexed.map(({ item, globalIndex }) => (
          <React.Fragment key={globalIndex}>
            {children(item, globalIndex)}
          </React.Fragment>
        ))}
      </ul>
    );
  }

  // Group by account key.
  const groups = new Map<string, typeof indexed>();
  for (const entry of indexed) {
    const key = getAccount(entry.item) ?? DEFAULT_ACCOUNT;
    const normalised = key in ACCOUNT_LABELS ? key : DEFAULT_ACCOUNT;
    if (!groups.has(normalised)) groups.set(normalised, []);
    groups.get(normalised)!.push(entry);
  }

  // Render flat if only one account has items.
  if (groups.size <= 1) {
    return (
      <ul className={listClassName}>
        {indexed.map(({ item, globalIndex }) => (
          <React.Fragment key={globalIndex}>
            {children(item, globalIndex)}
          </React.Fragment>
        ))}
      </ul>
    );
  }

  // Multi-account: render each group with a labeled divider.
  // Primary account first, then secondary.
  const orderedKeys = [DEFAULT_ACCOUNT, ...Object.keys(ACCOUNT_LABELS).filter((k) => k !== DEFAULT_ACCOUNT)].filter(
    (k) => groups.has(k)
  );

  return (
    <div className="space-y-4">
      {orderedKeys.map((accountKey) => {
        const entries = groups.get(accountKey) ?? [];
        const meta = ACCOUNT_LABELS[accountKey] ?? {
          label: accountKey,
          email: accountKey,
          color: 'text-slate-600 bg-slate-50 border-slate-200',
        };
        return (
          <div key={accountKey}>
            {/* Account sub-header */}
            <div className="flex items-center gap-2 mb-2">
              <span
                className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${meta.color}`}
              >
                📬 {meta.email}
              </span>
              <span className="text-[10px] text-slate-400">
                {entries.length} item{entries.length === 1 ? '' : 's'}
              </span>
            </div>
            <ul className={listClassName}>
              {entries.map(({ item, globalIndex }) => (
                <React.Fragment key={globalIndex}>
                  {children(item, globalIndex)}
                </React.Fragment>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

// React import needed for Fragment
import React from 'react';
