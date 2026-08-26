import { randomUUID } from 'node:crypto';
import type { CollabComment, CollaborationStorage } from '../types.js';

/**
 * Anchored comments service — generic over content type.
 *
 * The library owns the lifecycle (create, resolve/reopen, remove) and the
 * anchor (CommentAnchor). Interpreting the anchor is up to the app's resolver —
 * the library knows nothing about tldraw canvases or text offsets; it only
 * persists and sorts.
 */
export class CommentService {
  constructor(private storage: CollaborationStorage) {}

  async list(docName: string, space?: string): Promise<CollabComment[]> {
    const comments = await this.storage.listComments(docName, space);
    return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async create(
    docName: string,
    comment: Omit<CollabComment, 'id' | 'createdAt' | 'updatedAt' | 'resolvedAt'>,
  ): Promise<CollabComment> {
    const now = new Date().toISOString();
    const created: CollabComment = {
      ...comment,
      documentName: docName,
      id: randomUUID(),
      resolvedAt: null,
      createdAt: now,
      updatedAt: null,
    };
    await this.storage.saveComment(docName, created);
    return created;
  }

  async resolve(
    docName: string,
    commentId: string,
    resolved: boolean,
  ): Promise<CollabComment | null> {
    const comments = await this.storage.listComments(docName);
    const target = comments.find((comment) => comment.id === commentId);
    if (!target) return null;

    const updated: CollabComment = {
      ...target,
      resolvedAt: resolved ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
    };
    await this.storage.saveComment(docName, updated);
    return updated;
  }

  async remove(docName: string, commentId: string): Promise<boolean> {
    const comments = await this.storage.listComments(docName);
    const exists = comments.some((comment) => comment.id === commentId);
    if (!exists) return false;
    await this.storage.deleteComment(docName, commentId);
    return true;
  }
}
