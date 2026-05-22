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
    title: 'Gmail Analysis',
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
    visibilityKey: null,
  },
  {
    title: 'Franchise Compliance',
    icon: ClipboardCheck,
    href: '/compliance',
    active: false,
    visibilityKey: null,
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
    <div className="min-h-screen bg-brand-50">
      {/* Header */}
      <header className="bg-white border-b border-brand-200 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-brand-900">
              Foot Solutions mngnt screen
            </h1>
            {user && (
              <p className="text-sm text-brand-500 mt-0.5">{user.email}</p>
            )}
          </div>
          <div className="flex items-center gap-4 flex-shrink-0">
            <CentralTimeBadge />
            {isAdmin && (
              <button
                onClick={() => setShowAdminPanel(true)}
                className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
                aria-label="Admin settings"
                title="Configure visibility for non-admin users"
              >
                <ShieldCheck className="w-4 h-4" aria-hidden="true" />
                Admin
              </button>
            )}
            <button
              onClick={handleSignOut}
              className="flex items-center gap-2 text-sm text-brand-600 hover:text-brand-900 transition-colors"
              aria-label="Sign out"
            >
              <LogOut className="w-4 h-4" aria-hidden="true" />
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Two-column layout: tiles on left, email feed on right */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
          {/* Tile grid */}
          <div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-5 self-start"
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

          {/* Email feed */}
          <EmailFeed />
        </div>
      </main>

      {/* Admin settings modal */}
      <AdminSettings open={showAdminPanel} onClose={() => setShowAdminPanel(false)} />
    </div>
  );
}
