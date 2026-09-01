import { createHmac } from 'node:crypto';

/**
 * Where the signing key of a self-hosted collaboration token comes from.
 *
 * One resolver for both ends of the credential — the issuer (`issueToken`,
 * behind `GET /collaboration/token` and `issueCollaborationToken`) and the
 * verifier (the drivers' handshake). They MUST read the same value: a token
 * signed with one key and checked against another is not a security failure,
 * it is a total outage where every handshake is refused and nothing in the
 * logs says why.
 */

/**
 * A secret, or a way to get one.
 *
 * The function form exists because the manager resolves its key lazily: the
 * default source is the AdonisJS `appKey`, which only exists once the app has
 * booted, and a driver is built before the first document is ever opened.
 */
export type CollabTokenSecret = string | (() => string | Promise<string>);

/**
 * Thrown when nothing anywhere declares a signing key.
 *
 * Fails closed, and says exactly what to set. The alternative — falling back
 * to an unsigned token when the key is missing — is the hole this whole
 * module exists to close: it would turn a misconfiguration into a server that
 * accepts `base64({"userId":"<anyone>"})` from an unauthenticated client.
 */
export class CollabTokenSecretMissingError extends Error {
  constructor() {
    super(
      '[@adonis-agora/collaboration] no signing secret available — refusing to issue or accept collaboration tokens. ' +
        'In an AdonisJS app this is normally the app key and needs no configuration — check that APP_KEY is set ' +
        'and config/app.ts exports `appKey`. Outside an app (or to use a dedicated key), set `tokenSecret` in ' +
        'config/collaboration.ts, or pass `tokenSecret` to the CollaborationManager.',
    );
    this.name = 'CollabTokenSecretMissingError';
  }
}

/**
 * Domain separation for the key derived from `appKey`.
 *
 * `appKey` already signs cookies and encrypts session payloads. Signing
 * collaboration tokens with the very same bytes would let a value produced by
 * one of those subsystems be replayed at another; one HMAC over a fixed label
 * makes the key used here unusable anywhere else. `v1` is there so a future
 * format change can invalidate every outstanding token by changing one string.
 *
 * Applied ONLY to the `appKey` fallback, never to a secret someone configured
 * on purpose — which is what makes {@link resolveTokenSecret} idempotent, and
 * therefore safe to run over a key it already resolved. The manager memoizes
 * its key and hands it to both the issuer and the driver, and each of them
 * resolves again; a derivation on every pass would give the two ends
 * different keys and refuse every handshake.
 */
const APP_KEY_DOMAIN = '@adonis-agora/collaboration:self-hosted-token:v1';

/** The app's `appKey`, domain-separated, when running inside a booted app. */
async function readAppKey(): Promise<string | undefined> {
  try {
    // Dynamic + optional: unavailable in plain unit tests, and in any process
    // that builds a manager without an AdonisJS app around it.
    const app = (await import('@adonisjs/core/services/app')).default as unknown as {
      config: { get(name: string, fallback?: unknown): unknown };
    };
    const key = app.config.get('app.appKey', undefined);
    // AdonisJS 6 wraps it in a `Secret<string>` so it never lands in a log by
    // accident; older apps (and tests) keep a plain string.
    const raw =
      typeof key === 'string'
        ? key
        : typeof (key as { release?: () => unknown } | undefined)?.release === 'function'
          ? (key as { release: () => unknown }).release()
          : undefined;
    if (typeof raw !== 'string' || raw.length === 0) return undefined;
    return createHmac('sha256', raw).update(APP_KEY_DOMAIN).digest('base64url');
  } catch {
    return undefined;
  }
}

/** `tokenSecret` declared in `config/collaboration.ts`, when there is one. */
async function readConfiguredSecret(): Promise<string | undefined> {
  try {
    const app = (await import('@adonisjs/core/services/app')).default as unknown as {
      config: { get(name: string, fallback?: unknown): unknown };
    };
    const secret = app.config.get('collaboration.tokenSecret', undefined);
    return typeof secret === 'string' && secret.length > 0 ? secret : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The key both ends of the credential use — the first source that has one:
 *
 * 1. what the caller passed (`CollaborationManager`'s `tokenSecret` option —
 *    the path a test or a non-Adonis embedder takes);
 * 2. `tokenSecret` in `config/collaboration.ts`;
 * 3. the app's `appKey`, domain-separated — so a normal AdonisJS app needs no
 *    configuration at all, which is the only way a security default actually
 *    gets adopted.
 *
 * Nothing found is an error, never a fallback. See
 * {@link CollabTokenSecretMissingError}.
 *
 * Idempotent for any explicit secret: resolving an already-resolved key
 * returns it unchanged, so the manager can memoize one key and let the issuer
 * and the driver each resolve it again without the two drifting apart.
 */
export async function resolveTokenSecret(source?: CollabTokenSecret): Promise<string> {
  const explicit = typeof source === 'function' ? await source() : source;
  const secret =
    (explicit && explicit.length > 0 ? explicit : undefined) ??
    (await readConfiguredSecret()) ??
    (await readAppKey());

  if (!secret) throw new CollabTokenSecretMissingError();
  return secret;
}
