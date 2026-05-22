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
 *
 * Active tiles: soft white surface with a colored gradient icon container,
 *               lifts on hover via the shared `.surface-hover` mixin.
 * Inactive tiles: dashed border + muted icon, conveys "preview" state
 *                 without the heavy-handed opacity blur.
 */
export default function TileCard({ title, icon: Icon, href, active }: TileCardProps) {
  const inner = (
    <>
      <div
        className={clsx(
          'flex items-center justify-center w-14 h-14 rounded-2xl mb-4 ring-1 ring-inset transition-colors',
          active
            ? 'bg-gradient-to-br from-slate-50 to-slate-100 ring-slate-200/80 text-slate-700 group-hover:from-slate-100 group-hover:to-slate-200'
            : 'bg-slate-50 ring-slate-200/60 text-slate-300'
        )}
        aria-hidden="true"
      >
        <Icon className="w-6 h-6" strokeWidth={1.75} />
      </div>
      <span
        className={clsx(
          'text-sm font-semibold tracking-tight',
          active ? 'text-slate-900' : 'text-slate-400'
        )}
      >
        {title}
      </span>
      {!active && (
        <span className="mt-2 inline-block text-[10px] font-medium uppercase tracking-wider bg-slate-100 text-slate-400 px-2 py-0.5 rounded-full">
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
        className="flex flex-col items-center justify-center px-6 py-7 rounded-2xl border border-dashed border-slate-200 bg-white/50 cursor-not-allowed select-none"
      >
        {inner}
      </div>
    );
  }

  return (
    <Link
      to={href}
      role="listitem"
      aria-label={title}
      className="group surface surface-hover flex flex-col items-center justify-center px-6 py-7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
    >
      {inner}
    </Link>
  );
}
