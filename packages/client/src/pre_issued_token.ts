import type { CollabTokenInfo } from './types.js';

/**
 * Validation for a token the server issued **before** the browser connected —
 * an Inertia/SSR page prop rather than the answer to `GET /collaboration/token`.
 *
 * A fetched token is fresh by construction; a pre-issued one is not. It was
 * minted while the page rendered and then sat in the HTML for as long as the
 * tab stayed open — a restored bfcache entry, a laptop that slept, a tab
 * reopened the next morning. Handing that to the transport buys nothing and
 * costs the first connection, so it is checked here and discarded when dead:
 * the session then takes the ordinary HTTP path, which is what it would have
 * done anyway without a pre-issued token.
 */

/**
 * How much life a pre-issued token must have left to be worth using.
 *
 * Not zero: between this check and the server reading the token there is a
 * socket to open, and a credential with 200ms left will be refused on arrival
 * — the failure just costs a round-trip and a reconnect before the client
 * gets the fresh token it could have fetched immediately.
 */
export const PRE_ISSUED_TOKEN_MIN_TTL_MS = 5_000;

/**
 * Expiry of a token, in epoch ms, or `undefined` when it has none.
 *
 * Reads the server-reported `expiresAt` first. The JWT fallback is for a
 * server older than that field: every collaboration token — edge and
 * self-hosted alike — is a signed JWT carrying its own `exp`, and ignoring it
 * would mean trusting a token this function can see is dead.
 *
 * `undefined` stays a legitimate answer for a token from some other issuer
 * that reports no expiry and is not a readable JWT. It used to be the normal
 * case: the self-hosted format was an unsigned base64 blob with no expiry at
 * all, which is exactly why it stopped being a format.
 */
export function preIssuedTokenExpiry(info: CollabTokenInfo): number | undefined {
  if (typeof info.expiresAt === 'number' && Number.isFinite(info.expiresAt)) {
    return info.expiresAt;
  }

  const parts = info.token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: unknown;
    };
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) return payload.exp * 1000;
  } catch {
    // Not a JWT we can read: no expiry known, which is the same answer as a
    // format that has none. Never a throw — a malformed token is handled by
    // falling back to HTTP, not by breaking the session that could recover.
  }
  return undefined;
}

/**
 * The token if it is worth opening a socket with, `undefined` otherwise.
 *
 * `undefined` is the whole failure mode by design: every rejection here lands
 * the session on the fetch path it already knows how to walk. There is no
 * state in which a bad page prop leaves a document unable to connect.
 */
export function usablePreIssuedToken(
  info: CollabTokenInfo | null | undefined,
  now: number = Date.now(),
): CollabTokenInfo | undefined {
  if (!info || typeof info !== 'object') return undefined;
  // engine and wsUrl are not decoration: without them there is no transport to
  // build, and a token missing them is not a shortcut, it is a crash.
  if (typeof info.token !== 'string' || info.token.length === 0) return undefined;
  if (typeof info.wsUrl !== 'string' || info.wsUrl.length === 0) return undefined;
  if (typeof info.engine !== 'string' || info.engine.length === 0) return undefined;

  const expiry = preIssuedTokenExpiry(info);
  if (expiry !== undefined && expiry - now <= PRE_ISSUED_TOKEN_MIN_TTL_MS) return undefined;

  return info;
}
