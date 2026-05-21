/**
 * Admin / visibility system.
 *
 * One owner email (ADMIN_EMAIL) has full visibility and can configure what
 * non-admin users see. All visibility decisions go through `isVisible()`,
 * which checks the admin override map (loaded from /admin/settings) before
 * falling back to a hardcoded default.
 *
 * Visibility keys (use these in components):
 *   dashboard.tile.tax              — CPA Tax Assistant tile
 *   dashboard.tile.payroll          — Payroll tile (locked anyway)
 *   dashboard.tile.compliance       — Franchise Compliance tile (locked anyway)
 *   credentials.gmail-corporate     — Foot Solutions Corporate Gmail entry
 *   sales.tab.reporting             — Sales & Revenue Reporting tab
 *   sales.trends.totalRevenue       — Total Revenue stat card on Trends tab
 *   sales.trends.avgTicket          — Avg Ticket stat card on Trends tab
 *
 * Add new keys here as the app grows; admin settings panel reads them
 * from VISIBILITY_KEYS so it stays in sync.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './auth';
import api from './api';

/** The owner email — full visibility, can configure admin settings. */
export const ADMIN_EMAIL = 'jandoossai@gmail.com';

/** All visibility keys + hardcoded defaults for non-admins. */
export const VISIBILITY_KEYS = {
  'dashboard.tile.tax':            { label: 'Dashboard — CPA Tax Assistant tile',  defaultVisible: false },
  'dashboard.tile.gmail':          { label: 'Dashboard — Gmail Analysis tile',     defaultVisible: false },
  'credentials.gmail-corporate':   { label: 'Credentials — Foot Solutions Corporate Gmail', defaultVisible: false },
  'sales.tab.reporting':           { label: 'Sales & Revenue — Reporting tab',     defaultVisible: false },
  'sales.trends.totalRevenue':     { label: 'Sales & Revenue — Total Revenue (Trends tab)', defaultVisible: false },
  'sales.trends.avgTicket':        { label: 'Sales & Revenue — Avg Ticket (Trends tab)',    defaultVisible: false },
  'sales.staff.beckyCommission':   { label: 'Sales & Revenue — Becky Commission card (Staff tab)', defaultVisible: false },
} as const;

export type VisibilityKey = keyof typeof VISIBILITY_KEYS;

interface AdminSettingsResponse {
  /** Map of visibility key → boolean. true = force visible, false = force hidden. */
  visibilityOverrides: Record<string, boolean>;
  /** Daily sales target in USD (used by the daily report email). */
  dailyTarget: number;
  updatedAt: string | null;
}

/**
 * Hook returning admin status + visibility settings + helpers.
 *
 * Usage:
 *   const { isAdmin, isVisible, settings, updateVisibility } = useAdmin();
 *   if (!isVisible('credentials.gmail-corporate')) return null;
 */
export function useAdmin() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const isAdmin = user?.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();

  const settingsQ = useQuery<AdminSettingsResponse>({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<AdminSettingsResponse>('/admin/settings').then((r) => r.data),
    staleTime: 5 * 60 * 1000,
    enabled: !!user, // only fetch when authenticated
  });

  const overrides = settingsQ.data?.visibilityOverrides ?? {};
  const dailyTarget = settingsQ.data?.dailyTarget ?? 1500;

  /**
   * Check if a feature should be visible to the current user.
   * Admin sees everything. Non-admin sees: override (if set) ?? default.
   */
  function isVisible(key: VisibilityKey): boolean {
    if (isAdmin) return true;
    if (key in overrides) return overrides[key]!;
    return VISIBILITY_KEYS[key].defaultVisible;
  }

  const updateMutation = useMutation({
    mutationFn: (next: Partial<{ visibilityOverrides: Record<string, boolean>; dailyTarget: number }>) =>
      api.put('/admin/settings', next).then((r) => r.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
  });

  function updateVisibility(key: VisibilityKey, visible: boolean) {
    const next = { ...overrides, [key]: visible };
    updateMutation.mutate({ visibilityOverrides: next });
  }

  function resetVisibility(key: VisibilityKey) {
    const next = { ...overrides };
    delete next[key];
    updateMutation.mutate({ visibilityOverrides: next });
  }

  function updateDailyTarget(target: number) {
    updateMutation.mutate({ dailyTarget: target });
  }

  return {
    isAdmin,
    isVisible,
    overrides,
    dailyTarget,
    isLoading: settingsQ.isLoading,
    isSaving: updateMutation.isPending,
    updateVisibility,
    resetVisibility,
    updateDailyTarget,
  };
}
