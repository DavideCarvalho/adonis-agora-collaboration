/**
 * Metadados de versões compartilhados entre drivers — mesma semântica de
 * histórico pro Automerge (nativo) e pro Yjs (snapshots).
 */

import { randomUUID } from 'node:crypto';
import type { CollabVersion } from './types.js';

/** Próximo número sequencial a partir das versões existentes. */
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
