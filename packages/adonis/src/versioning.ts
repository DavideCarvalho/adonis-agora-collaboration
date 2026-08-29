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

/**
 * Label carried by the version a restore creates out of the state it is
 * about to replace — the "restored from X" entry the driver contract
 * promises. Shared so both engines phrase it identically.
 */
export function restoredFromLabel(
  target: Pick<CollabVersion, 'seq' | 'label'> | undefined,
  versionId: string,
): string {
  if (!target) return `restored from ${versionId}`;
  return `restored from #${target.seq}${target.label ? ` (${target.label})` : ''}`;
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
