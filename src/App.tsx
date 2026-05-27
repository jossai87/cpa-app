import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import Login from './pages/Login';
import Callback from './pages/Callback';
import Dashboard from './pages/Dashboard';
import OwnerHome from './pages/OwnerHome';
import CpaTaxAssistant from './pages/CpaTaxAssistant';
import Credentials from './pages/Credentials';
import SalesRevenue from './pages/SalesRevenue';
import GmailAnalysis from './pages/GmailAnalysis';
import Campaigns from './pages/Campaigns';
import Spinner from './components/Spinner';
import ErrorBoundary from './components/ErrorBoundary';
import FsAssistant from './components/FsAssistant';
import { ADMIN_EMAIL } from './lib/admin';

/**
 * HomeRoute — picks the landing screen based on user role.
 *   • Admin (jandoossai@gmail.com) → full module dashboard
 *   • Non-admin (owner / staff)    → curated OwnerHome with the
 *                                    six cards they actually use
 *
 * The floating FS Assistant chatbot stays mounted via ProtectedShell on
 * both paths, so the chat-icon-in-corner UX is identical for everyone.
 */
function HomeRoute() {
  const { user } = useAuth();
  const isAdmin = user?.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();
  return isAdmin ? <Dashboard /> : <OwnerHome />;
}

/**
 * ProtectedShell — wraps every authenticated route's element so the
 * unified `<FsAssistant />` bubble mounts once and survives navigation
 * (Task 16.1, Reqs 1.1, 1.2, 1.5). The bubble itself reads the Vite
 * `VITE_ASSISTANT_ENABLED` flag and returns null when off, so the
 * cutover (Task 18.1) is a single env-var flip.
 */
function ProtectedShell({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary>
      {children}
      <FsAssistant />
    </ErrorBoundary>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <ProtectedShell>{children}</ProtectedShell>;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<Login />} />
          <Route path="/callback" element={<Callback />} />

          {/* Protected routes */}
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <HomeRoute />
              </ProtectedRoute>
            }
          />
          <Route
            path="/tax"
            element={
              <ProtectedRoute>
                <CpaTaxAssistant />
              </ProtectedRoute>
            }
          />
          <Route
            path="/credentials"
            element={
              <ProtectedRoute>
                <Credentials />
              </ProtectedRoute>
            }
          />
          <Route
            path="/sales"
            element={
              <ProtectedRoute>
                <SalesRevenue />
              </ProtectedRoute>
            }
          />
          <Route
            path="/gmail"
            element={
              <ProtectedRoute>
                <GmailAnalysis />
              </ProtectedRoute>
            }
          />
          <Route
            path="/campaigns"
            element={
              <ProtectedRoute>
                <Campaigns />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
