import { useState } from 'react';
import {
  Calculator,
  KeyRound,
  TrendingUp,
  Users,
  ClipboardCheck,
  LogOut,
  ShieldCheck,
  Mail,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useAdmin } from '../lib/admin';
import TileCard from '../components/TileCard';
import CentralTimeBadge from '../components/CentralTimeBadge';
import AdminSettings from '../components/AdminSettings';
import EmailFeed from '../components/EmailFeed';

const ALL_TILES = [
  {
    title: 'Sales & Revenue',
    icon: TrendingUp,
    href: '/sales',
    active: true,
    visibilityKey: null,
  },
  {
    title: 'Gmail Assistant',
    icon: Mail,
    href: '/gmail',
    active: true,
    visibilityKey: 'dashboard.tile.gmail' as const,
  },
  {
    title: 'CPA Tax Assistant',
    icon: Calculator,
    href: '/tax',
    active: true,
    visibilityKey: 'dashboard.tile.tax' as const,
  },
  {
    title: 'Credentials',
    icon: KeyRound,
    href: '/credentials',
    active: true,
    visibilityKey: null,
  },
  {
    title: 'Payroll',
    icon: Users,
    href: '/payroll',
    active: false,
    visibilityKey: 'dashboard.tile.payroll' as const,
  },
  {
    title: 'Franchise Compliance',
    icon: ClipboardCheck,
    href: '/compliance',
    active: false,
    visibilityKey: 'dashboard.tile.compliance' as const,
  },
];

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const { isAdmin, isVisible } = useAdmin();
  const [showAdminPanel, setShowAdminPanel] = useState(false);

  const handleSignOut = () => {
    void signOut();
  };

  const tiles = ALL_TILES.filter((tile) => {
    if (!tile.visibilityKey) return true;
    return isVisible(tile.visibilityKey);
  });

  return (
    <div className="min-h-screen">
      {/* Header — sticky, translucent, blurred */}
      <header className="app-header px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
              Foot Solutions
              <span className="text-slate-400 font-normal ml-1.5">— Management</span>
            </h1>
            {user && (
              <p className="text-xs text-slate-500 mt-0.5">{user.email}</p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <CentralTimeBadge />
            {isAdmin && (
              <button
                onClick={() => setShowAdminPanel(true)}
                className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors"
                aria-label="Admin settings"
                title="Configure visibility for non-admin users"
              >
                <ShieldCheck className="w-4 h-4" aria-hidden="true" />
                Admin
              </button>
            )}
            <button
              onClick={handleSignOut}
              className="btn-ghost"
              aria-label="Sign out"
            >
              <LogOut className="w-4 h-4" aria-hidden="true" />
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Single-column layout: tiles on top (full width), email feed
          centered below. Gives Daily Briefings more reading width. */}
      <main className="max-w-7xl mx-auto px-6 py-10 space-y-8">
        {/* Tile grid */}
        <div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5"
          role="list"
          aria-label="Management modules"
        >
          {tiles.map((tile) => (
            <TileCard
              key={tile.title}
              title={tile.title}
              icon={tile.icon}
              href={tile.href}
              active={tile.active}
            />
          ))}
        </div>

        {/* Email feed — centered, capped width for readability */}
        <div className="max-w-3xl mx-auto">
          <EmailFeed />
        </div>
      </main>

      {/* Admin settings modal */}
      <AdminSettings open={showAdminPanel} onClose={() => setShowAdminPanel(false)} />
    </div>
  );
}
