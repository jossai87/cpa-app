/**
 * Campaigns — admin-only customer-email campaign tooling.
 *
 * Reachable from the FS Management Dashboard tile (admin only).
 * The heavy lifting lives in <CampaignCard /> — this page just provides
 * the standard page chrome (header, back-to-Dashboard link, sign-out).
 */

import { Link } from 'react-router-dom';
import { ArrowLeft, LogOut } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useAdmin } from '../lib/admin';
import CentralTimeBadge from '../components/CentralTimeBadge';
import CampaignCard from '../components/CampaignCard';

export default function Campaigns() {
  const { user, signOut } = useAuth();
  const { isAdmin } = useAdmin();

  const handleSignOut = () => {
    void signOut();
  };

  // Admin-only — non-admins are redirected to OwnerHome by `<HomeRoute />`,
  // but if they hit /campaigns directly we show a friendly forbidden state.
  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center">
          <h1 className="text-xl font-semibold text-slate-900">
            Admin only
          </h1>
          <p className="text-sm text-slate-600 mt-2">
            Campaign tools are available to the admin account only.
          </p>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline mt-4"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="app-header px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center gap-4">
          <Link to="/" className="btn-ghost">
            <ArrowLeft className="w-4 h-4" />
            Dashboard
          </Link>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            Campaign
          </h1>
          <CentralTimeBadge />
          <div className="ml-auto flex items-center gap-2">
            {user && <p className="text-xs text-slate-500">{user.email}</p>}
            <button onClick={handleSignOut} className="btn-ghost" aria-label="Sign out">
              <LogOut className="w-4 h-4" aria-hidden="true" />
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        <CampaignCard />
      </main>
    </div>
  );
}
