import { hkdfSync } from 'node:crypto';

/**
 * Keys of the edge (`partykit`) engine, all derived from `partykit.jwtSecret`.
 *
 * One secret is configured (`COLLAB_JWT_SECRET`, on both Adonis and the
 * worker), but it is used for three different jobs, and each job gets its own
 * key so that holding one of them never grants another:
 *
 * | key                    | who signs / sends        | who checks                     |
 * | ---------------------- | ------------------------ | ------------------------------ |
 * | `jwtSecret` itself     | Adonis (browser tokens)  | worker (`onConnect`)           |
 * | server key (derived)   | Adonis (`PartyKitDriver`)| worker (`onRequest`)           |
 * | worker secret (derived)| worker (`POST /state`)   | Adonis (`x-collab-worker-secret`) |
 *
 * Why it matters:
 *
 * - The worker secret travels as a request header. It used to be the JWT
 *   signing key itself, so anything that logged request headers (a proxy, an
 *   APM) logged the key that mints a token for every user and document.
 * - The worker's HTTP API (`onRequest`) applies arbitrary updates to a room.
 *   It used to accept any token signed with `jwtSecret` — which every reader
 *   of a document receives. A server token is now signed with a key no
 *   browser token is ever signed with, so a user id that happens to equal
 *   `adonis-server` buys nothing either.
 *
 * HKDF-SHA256 with a fixed salt and a purpose label; the worker template
 * (`stubs/partykit/worker/party.ts.stub`) runs the exact same derivation in
 * WebCrypto. The constants below are duplicated there on purpose (the worker
 * is a separate deployment with no dependency on this package) — a test reads
 * the stub and fails if they drift apart.
 */

/** HKDF salt shared by every edge-engine derivation. */
export const PARTYKIT_HKDF_SALT = '@adonis-agora/collaboration:partykit';

/** Purpose label of the worker → Adonis shared secret (`x-collab-worker-secret`). */
export const PARTYKIT_WORKER_SECRET_LABEL = 'worker-secret:v1';

/** Purpose label of the key that signs Adonis → worker calls (`onRequest`). */
export const PARTYKIT_SERVER_KEY_LABEL = 'server-token:v1';

/**
 * Identity in the token the worker signs (with the worker secret) to read a
 * room's persisted state from `GET /collaboration/state`. Bound to one
 * document and valid for a minute; never issued to, or accepted from, a user.
 */
export const PARTYKIT_WORKER_IDENTITY = 'partykit-worker';

/** HKDF-SHA256(secret, salt, label) → 32 bytes, base64url. */
export function derivePartyKitKey(secret: string, label: string): string {
  const bytes = hkdfSync('sha256', secret, PARTYKIT_HKDF_SALT, label, 32);
  return Buffer.from(bytes).toString('base64url');
}

/**
 * The secret the worker sends in `x-collab-worker-secret` when it persists a
 * room: `partykit.workerSecret` when the app set one explicitly, otherwise
 * derived from `jwtSecret` — so no extra env var is needed.
 *
 * `undefined` when neither is configured; the caller refuses the request.
 */
export function resolvePartyKitWorkerSecret(partykit: {
  jwtSecret?: string | undefined;
  workerSecret?: string | undefined;
}): string | undefined {
  if (partykit.workerSecret) return partykit.workerSecret;
  if (!partykit.jwtSecret) return undefined;
  return derivePartyKitKey(partykit.jwtSecret, PARTYKIT_WORKER_SECRET_LABEL);
}

/** The key the driver signs its own worker calls with. */
export function partyKitServerKey(jwtSecret: string): string {
  return derivePartyKitKey(jwtSecret, PARTYKIT_SERVER_KEY_LABEL);
}
