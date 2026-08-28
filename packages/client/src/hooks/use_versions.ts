import { useCallback, useEffect, useRef, useState } from 'react';
import { useCollaborationContext } from '../context.js';
import {
  createVersion as apiCreateVersion,
  restoreVersion as apiRestoreVersion,
  listVersions,
} from '../rest_client.js';
import type { CollabVersion } from '../types.js';

export interface UseVersionsOptions {
  docName: string;
}

export interface UseVersionsResult {
  versions: CollabVersion[];
  loading: boolean;
  error: Error | null;
  refresh(): Promise<void>;
  create(label?: string | null): Promise<CollabVersion>;
  restore(versionId: string): Promise<void>;
}

/**
 * Version control de um documento (REST — snapshots ficam no Adonis).
 *
 * ```tsx
 * const { versions, create, restore } = useVersions('researches/42/writing')
 * ```
 */
export function useVersions(options: UseVersionsOptions): UseVersionsResult {
  const { docName } = options;
  const context = useCollaborationContext();
  const config = context.getConfig();
  // Versões são REST puro — sem sessão/Y.Doc criados no corpo do render.

  const [versions, setVersions] = useState<CollabVersion[]>([]);
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
      const data = await listVersions(config, docName);
      if (mountedRef.current) {
        setVersions(data);
        setError(null);
      }
    } catch (cause) {
      if (mountedRef.current) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [config, docName]);

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

  return { versions, loading, error, refresh, create, restore };
}
