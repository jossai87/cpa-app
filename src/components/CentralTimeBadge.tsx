import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';

/**
 * A small live "Central Time" badge for page headers.
 *
 * Updates every 30 seconds. Hidden on small mobile to save space.
 * The store is in Flower Mound, TX — so we always render America/Chicago
 * regardless of the user's local timezone.
 */
export default function CentralTimeBadge({ className }: { className?: string }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(tick);
  }, []);

  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);

  return (
    <span
      className={
        className ??
        'hidden md:inline-flex items-center gap-1 text-xs text-slate-500 bg-slate-100 border border-slate-200 rounded-full px-2.5 py-1'
      }
      title="Live store-local time (Flower Mound, TX)"
    >
      <Clock className="w-3 h-3 text-slate-400" />
      {formatted} CT
    </span>
  );
}
