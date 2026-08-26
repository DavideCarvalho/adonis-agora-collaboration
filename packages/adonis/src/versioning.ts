/**
 * Version metadata shared across drivers — same history semantics for
 * Automerge (native) and Yjs (snapshots).
 */

import { randomUUID } from 'node:crypto';
import type { CollabVersion } from './types.js';

/** Next sequential number based on the existing versions. */
export function seqVersions(existing: CollabVersion[]): number {
  return existing.reduce((max, version) => Math.max(max, version.seq), 0) + 1;
}

export function createVersionMetadata(
  createdBy: string | null,
  label: string | null,
  seq: number,
): CollabVersion {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    createdBy,
    label,
    seq,
  };
}
