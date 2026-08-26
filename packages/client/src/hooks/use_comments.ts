import { useCallback, useEffect, useRef, useState } from 'react';
import { getOrCreateSession, useCollaborationContext } from '../context.js';
import {
  createComment as apiCreateComment,
  deleteComment as apiDeleteComment,
  listComments,
  resolveComment,
} from '../rest_client.js';
import type { CollabComment } from '../types.js';

export interface UseCommentsResult {
  comments: CollabComment[];
  loading: boolean;
  error: Error | null;
  refresh(): Promise<void>;
  create(
    input: Pick<CollabComment, 'space' | 'anchor' | 'body' | 'userId'> & {
      authorName?: string | null;
    },
  ): Promise<CollabComment>;
  resolve(commentId: string, resolved?: boolean): Promise<void>;
  remove(commentId: string): Promise<void>;
}

/**
 * Comentários ancorados de um documento (REST — dados relacionais no Adonis).
 *
 * ```tsx
 * const { comments, create, resolve } = useComments('researches/42/writing', 'text')
 * ```
 */
export function useComments(docName: string, space?: string): UseCommentsResult {
  const context = useCollaborationContext();
  const config = context.getConfig();

  // Mantém a sessão viva (compartilha o ciclo do doc) sem exigir o WS pra
  // comentários — REST funciona mesmo com engine offline.
  void getOrCreateSession(context, docName);

  const [comments, setComments] = useState<CollabComment[]>([]);
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
      const data = await listComments(config, docName, space);
      if (mountedRef.current) {
        setComments(data);
        setError(null);
      }
    } catch (cause) {
      if (mountedRef.current) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [config, docName, space]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback<UseCommentsResult['create']>(
    async (input) => {
      const comment = await apiCreateComment(config, { ...input, documentName: docName });
      await refresh();
      return comment;
    },
    [config, docName, refresh],
  );

  const resolve = useCallback<UseCommentsResult['resolve']>(
    async (commentId, resolved = true) => {
      await resolveComment(config, docName, commentId, resolved);
      setComments((current) =>
        current.map((comment) =>
          comment.id === commentId
            ? { ...comment, resolvedAt: resolved ? new Date().toISOString() : null }
            : comment,
        ),
      );
    },
    [config, docName],
  );

  const remove = useCallback<UseCommentsResult['remove']>(
    async (commentId) => {
      await apiDeleteComment(config, docName, commentId);
      setComments((current) => current.filter((comment) => comment.id !== commentId));
    },
    [config, docName],
  );

  return { comments, loading, error, refresh, create, resolve, remove };
}
