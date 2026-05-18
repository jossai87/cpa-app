import {
  Calculator,
  KeyRound,
  TrendingUp,
  Package,
  Users,
  ClipboardCheck,
  BarChart3,
  LogOut,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import TileCard from '../components/TileCard';

const tiles = [
  {
    title: 'CPA Tax Assistant',
    icon: Calculator,
    href: '/tax',
    active: true,
  },
  {
    title: 'Credentials',
    icon: KeyRound,
    href: '/credentials',
    active: true,
  },
  {
    title: 'Sales & Revenue',
    icon: TrendingUp,
    href: '/sales',
    active: true,
  },
  {
    title: 'Inventory',
    icon: Package,
    href: '/inventory',
    active: false,
  },
  {
    title: 'Payroll',
    icon: Users,
    href: '/payroll',
    active: false,
  },
  {
    title: 'Franchise Compliance',
    icon: ClipboardCheck,
    href: '/compliance',
    active: false,
  },
  {
    title: 'Reports',
    icon: BarChart3,
    href: '/reports',
    active: false,
  },
];

export default function Dashboard() {
  const { user, signOut } = useAuth();

  const handleSignOut = () => {
    void signOut();
  };

  return (
    <div className="min-h-screen bg-brand-50">
      {/* Header */}
      <header className="bg-white border-b border-brand-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-brand-900">
              Foot Solutions mngnt screen
            </h1>
            {user && (
              <p className="text-sm text-brand-500 mt-0.5">{user.email}</p>
            )}
          </div>
          <button
            onClick={handleSignOut}
            className="flex items-center gap-2 text-sm text-brand-600 hover:text-brand-900 transition-colors"
            aria-label="Sign out"
          >
            <LogOut className="w-4 h-4" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </header>

      {/* Tile grid */}
      <main className="max-w-6xl mx-auto px-6 py-10">
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
      </main>
    </div>
  );
}
