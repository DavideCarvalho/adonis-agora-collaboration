import type { CollabStatus } from '../types.js';

/**
 * Maps a provider's raw status string onto the session-level CollabStatus.
 * Single normalization point for every transport adapter.
 */
export function normalizeStatus(
  raw: string | undefined,
  fallback: CollabStatus = 'connecting',
): CollabStatus {
  if (raw === 'connected') return 'connected';
  if (raw === 'disconnected') return 'disconnected';
  return fallback;
}
