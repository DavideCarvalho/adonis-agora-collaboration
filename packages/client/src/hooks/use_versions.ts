import type { OffsetPageMeta } from '@adonis-agora/filter-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCollaborationContext } from '../context.js';
import {
  createVersion as apiCreateVersion,
  restoreVersion as apiRestoreVersion,
  listVersions,
} from '../rest_client.js';
import type { CollabVersion, CollabVersionListOptions } from '../types.js';

export interface UseVersionsOptions extends CollabVersionListOptions {
  docName: string;
}

export interface UseVersionsResult {
  /** The current page's versions. */
  versions: CollabVersion[];
  /** Paging of the last fetch (`total`, `currentPage`, `lastPage`…); `null` before it lands. */
  meta: OffsetPageMeta | null;
  loading: boolean;
  error: Error | null;
  refresh(): Promise<void>;
  create(label?: string | null): Promise<CollabVersion>;
  restore(versionId: string): Promise<void>;
}

/**
 * Version control de um documento (REST — snapshots ficam no Adonis).
 *
 * Lista uma página por vez (`size` padrão 50); `sort: '-seq'` traz as mais
 * novas primeiro.
 *
 * ```tsx
 * const { versions, meta, create, restore } = useVersions({ docName, sort: '-seq' })
 * ```
 */
export function useVersions(options: UseVersionsOptions): UseVersionsResult {
  const { docName, page, size, sort } = options;
  const context = useCollaborationContext();
  const config = context.getConfig();
  // Versões são REST puro — sem sessão/Y.Doc criados no corpo do render.

  const [versions, setVersions] = useState<CollabVersion[]>([]);
  const [meta, setMeta] = useState<OffsetPageMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listVersions(config, docName, { page, size, sort });
      if (mountedRef.current) {
        setVersions(result.data);
        setMeta(result.meta);
        setError(null);
      }
    } catch (cause) {
      if (mountedRef.current) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [config, docName, page, size, sort]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback<UseVersionsResult['create']>(
    async (label = null) => {
      const version = await apiCreateVersion(config, docName, label);
      await refresh();
      return version;
    },
    [config, docName, refresh],
  );

  const restore = useCallback<UseVersionsResult['restore']>(
    async (versionId) => {
      await apiRestoreVersion(config, docName, versionId);
      await refresh();
    },
    [config, docName, refresh],
  );

  return { versions, meta, loading, error, refresh, create, restore };
}
