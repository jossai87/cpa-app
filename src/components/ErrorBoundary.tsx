/**
 * Top-level error boundary so a runtime throw in any page or component
 * doesn't blank the whole app. Without this, a render-loop or null deref
 * collapses the entire route tree to an empty screen — terrible for users
 * who hit it in production.
 *
 * React still requires a class component for `componentDidCatch` /
 * `getDerivedStateFromError`, even in 2026.
 */

import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AlertCircle, RefreshCw, Home } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Log enough detail for the console while keeping it tame.
    console.error('App error boundary caught:', error, errorInfo);
    this.setState({ errorInfo });
  }

  reset = () => {
    this.setState({ error: null, errorInfo: null });
  };

  goHome = () => {
    window.location.href = '/';
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    const message = this.state.error.message ?? 'Unknown error';

    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-6 py-10">
        <div className="max-w-lg w-full bg-white rounded-xl border border-slate-200 shadow-sm p-6">
          <div className="flex items-start gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-red-100 text-red-700 flex-shrink-0">
              <AlertCircle className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-base font-semibold text-slate-900">
                Something went wrong
              </h1>
              <p className="text-sm text-slate-600 mt-1">
                The page hit a runtime error. Try reloading or returning to the
                dashboard.
              </p>
              <div className="mt-3 bg-slate-50 border border-slate-200 rounded p-3">
                <p className="text-xs font-mono text-slate-600 break-words">
                  {message}
                </p>
              </div>
              <div className="flex items-center gap-2 mt-4">
                <button
                  onClick={this.reset}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Try again
                </button>
                <button
                  onClick={this.goHome}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition"
                >
                  <Home className="w-3.5 h-3.5" />
                  Back to dashboard
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
