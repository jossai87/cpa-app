import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import type { PersistedDocument } from '../types';

/** Fetch all uploaded documents for the current user. */
export function useDocuments() {
  return useQuery<PersistedDocument[]>({
    queryKey: ['documents'],
    queryFn: () =>
      api
        .get<{ documents: PersistedDocument[] }>('/documents')
        .then((r) => r.data.documents),
    staleTime: 60 * 1000,
  });
}

/** Open a download for a document via pre-signed S3 URL. */
export function useDownloadDocument() {
  return useMutation({
    mutationFn: async (docId: string) => {
      const r = await api.get<{ downloadUrl: string; fileName: string }>(
        `/documents/${docId}/download-url`
      );
      // Open in new tab — browser will trigger download
      window.open(r.data.downloadUrl, '_blank', 'noopener');
      return r.data;
    },
  });
}

/** Delete a document and refresh the list. */
export function useDeleteDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (docId: string) =>
      api.delete<{ docId: string; appliedTotals: Record<string, number> }>(
        `/documents/${docId}`
      ).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['documents'] });
    },
  });
}

/**
 * Bulk-delete every document for the current user. Used by the "Reset
 * Everything" flow on the tax page. Backend deletes both DynamoDB metadata
 * and S3 objects.
 */
export function useDeleteAllDocuments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      api
        .delete<{ deletedCount: number; s3FailureCount?: number }>(
          '/documents'
        )
        .then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['documents'] });
    },
  });
}

/**
 * Resolve a flagged transaction.
 *  - action 'apply': adds the amount to a tax form field
 *  - action 'ignore': marks resolved without applying
 *  - action 'unresolve': clears any prior resolution and rolls back form additions
 *
 * Returns the formDelta map ({ field: change }) so the caller can update the
 * form's running totals without a full refetch.
 */
export function useResolveFlagged() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      docId,
      index,
      action,
      field,
      appliedAmount,
    }: {
      docId: string;
      index: number;
      action: 'apply' | 'ignore' | 'unresolve';
      field?: string;
      appliedAmount?: number;
    }) =>
      api
        .post<{
          docId: string;
          index: number;
          resolution: {
            action: 'apply' | 'ignore';
            field?: string;
            appliedAmount?: number;
            resolvedAt: string;
          } | null;
          appliedTotals: Record<string, number>;
          formDelta: Record<string, number>;
        }>(`/documents/${docId}/flagged/${index}/resolve`, {
          action,
          ...(field && { field }),
          ...(appliedAmount !== undefined && { appliedAmount }),
        })
        .then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['documents'] });
    },
  });
}
