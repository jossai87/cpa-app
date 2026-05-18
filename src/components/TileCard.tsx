import { Link } from 'react-router-dom';
import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';

interface TileCardProps {
  title: string;
  icon: LucideIcon;
  href: string;
  active: boolean;
}

/**
 * Dashboard tile card.
 * Active tiles are navigable links. Inactive tiles show a "Coming Soon" badge
 * and are rendered as non-interactive elements.
 */
export default function TileCard({ title, icon: Icon, href, active }: TileCardProps) {
  const content = (
    <>
      <div
        className={clsx(
          'flex items-center justify-center w-12 h-12 rounded-xl mb-4',
          active ? 'bg-brand-100 text-brand-700' : 'bg-brand-50 text-brand-300'
        )}
        aria-hidden="true"
      >
        <Icon className="w-6 h-6" />
      </div>
      <span
        className={clsx(
          'text-sm font-medium',
          active ? 'text-brand-900' : 'text-brand-400'
        )}
      >
        {title}
      </span>
      {!active && (
        <span className="mt-2 inline-block text-xs font-medium bg-brand-100 text-brand-400 px-2 py-0.5 rounded-full">
          Coming Soon
        </span>
      )}
    </>
  );

  if (!active) {
    return (
      <div
        role="listitem"
        aria-label={`${title} — coming soon`}
        className="flex flex-col items-center justify-center p-6 bg-white rounded-xl border border-brand-100 opacity-60 cursor-not-allowed select-none"
      >
        {content}
      </div>
    );
  }

  return (
    <Link
      to={href}
      role="listitem"
      aria-label={title}
      className="flex flex-col items-center justify-center p-6 bg-white rounded-xl border border-brand-200 hover:border-brand-400 hover:shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      {content}
    </Link>
  );
}
