import { readFile } from 'node:fs/promises';

/**
 * Marker the current worker template carries. A `partykit-worker/party.ts`
 * without it was generated from an older template, which lets read-only users
 * write and accepts any user token on its HTTP API — it has to be regenerated
 * and redeployed, and a library that changed the protocol under it says so.
 */
export const PARTYKIT_WORKER_PROTOCOL_MARKER = 'Worker protocol v2 (@adonis-agora/collaboration)';

/** What to run to bring a generated worker up to date. */
export const PARTYKIT_WORKER_UPGRADE_STEPS =
  'Regenerate it with `node ace collaboration:init --engine=partykit --force`, remove any old ' +
  'COLLAB_WORKER_SECRET (`npx partykit secret delete COLLAB_WORKER_SECRET`, it is now derived from ' +
  'COLLAB_JWT_SECRET) and run `npx partykit deploy`.';

/**
 * Whether a generated worker file is current. `missing` when there is no file
 * at that path (the worker may live in another repository) — not an error.
 */
export async function partyKitWorkerStubStatus(
  path: string,
): Promise<'missing' | 'current' | 'outdated'> {
  let source: string;
  try {
    source = await readFile(path, 'utf-8');
  } catch {
    return 'missing';
  }
  return source.includes(PARTYKIT_WORKER_PROTOCOL_MARKER) ? 'current' : 'outdated';
}

/** The warning both the provider and `collaboration:init` print. */
export function outdatedPartyKitWorkerMessage(path: string): string {
  return (
    `[@adonis-agora/collaboration] ${path} was generated from an older PartyKit worker template: ` +
    'it lets read-only users edit documents and accepts any user token on its HTTP API. ' +
    PARTYKIT_WORKER_UPGRADE_STEPS
  );
}
