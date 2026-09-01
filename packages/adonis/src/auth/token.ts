import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CollabConnectionContext, CollabPermission, PartyKitConfig } from '../types.js';
import { type CollabTokenSecret, resolveTokenSecret } from './secret.js';

/**
 * The token/auth module — the single seam for issuing and verifying
 * collaboration credentials.
 *
 * **One wire format, two secrets.** Both the edge (`partykit`) and the
 * self-hosted engines (`yjs`/`automerge`) carry an HS256 JWT bound to one
 * document and valid for {@link COLLAB_TOKEN_TTL_SECONDS}; they differ only
 * in which key signs it (the worker's `jwtSecret` vs. the app's own key — see
 * `auth/secret.ts`) and therefore in who can verify it.
 *
 * It used to differ in more than that: the self-hosted format was a bare
 * base64 of the connection context, unsigned and without an expiry. That is
 * not a credential — anyone could send `base64({"userId":"<victim>"})` with no
 * session, no cookie and no login, and the driver would authorize the
 * handshake as that user and let them write. The format is gone; a token that
 * is not signed by this server is not accepted by it.
 *
 * `issueToken` also enforces `config.authorize` on the REST path — the
 * permission seam must hold outside the WebSocket handshake too.
 */

export interface TokenIssuerConfig {
  engine: string;
  /** WS path of the embedded Hocuspocus server (self-hosted engines). */
  path?: string;
  partykit?: Partial<Pick<PartyKitConfig, 'roomHost' | 'jwtSecret' | 'party'>>;
  /**
   * Signing key for the self-hosted format. Resolved through
   * {@link resolveTokenSecret}, so the issuer and the driver that verifies
   * the token read the same source and cannot drift apart.
   */
  tokenSecret?: CollabTokenSecret;
}

/** Minimal authorize contract — mirrors CollaborationConfig.authorize. */
export type AuthorizeFn = (
  ctx: CollabConnectionContext,
  docName: string,
) => Promise<CollabPermission>;

/**
 * Lifetime of a collaboration token, in seconds.
 *
 * Named rather than inlined because three places need the same number: the
 * signature's `exp`, the `expiresAt` the issuer reports back so a caller
 * holding the token ahead of time can tell it is already dead, and the
 * client's decision to discard a page-prop token instead of opening a socket
 * with it.
 *
 * Five minutes is what the edge format has always used, and the self-hosted
 * one now matches it deliberately: the token is spent within milliseconds of
 * being issued (the browser fetches it and connects), and a long-lived one
 * would only widen the window in which a leaked URL still opens a document.
 * The socket it opens is not cut short by expiry — `authorize` runs once at
 * the handshake and the connection then lives on its own.
 */
export const COLLAB_TOKEN_TTL_SECONDS = 300;

/**
 * The old name of {@link COLLAB_TOKEN_TTL_SECONDS}, kept because it is public
 * API that apps and the worker template already read. One number, because one
 * wire format: a second constant would eventually drift from this one and the
 * drift would show up as tokens that expire earlier than the client thinks.
 */
export const PARTYKIT_TOKEN_TTL_SECONDS = COLLAB_TOKEN_TTL_SECONDS;

/** What a signed collaboration token carries. */
export interface CollabTokenPayload {
  userId: string;
  /**
   * The document the credential opens — and only that one. Verified against
   * the document actually being connected to; without that check a token
   * legitimately issued for a document the caller may read would also open
   * every document they may not.
   */
  docName: string;
  /** Presence metadata, carried so the roster does not need a second lookup. */
  user?: { name?: string; avatarUrl?: string | null };
}

/** Signs a minimal HS256 JWT — no external dependency. */
export function signCollabToken(
  payload: CollabTokenPayload,
  secret: string,
  expiresInSeconds = COLLAB_TOKEN_TTL_SECONDS,
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSeconds };
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode(header)}.${encode(body)}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

/**
 * Verifies signature, expiry and document binding of a token issued by
 * {@link signCollabToken}. Returns `null` for every failure — a verifier that
 * distinguishes "bad signature" from "wrong document" in its return value
 * invites a caller to treat one of them as recoverable.
 *
 * `expectedDocName` is required rather than optional on purpose: every caller
 * knows which document is being opened, and an optional argument is one a
 * caller forgets — which is exactly the bug this parameter exists to prevent.
 */
export function verifyCollabToken(
  token: string,
  secret: string,
  expectedDocName: string,
): (CollabTokenPayload & { exp: number }) | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  const received = Buffer.from(signature, 'base64url');
  // Constant time, and length-checked first because timingSafeEqual throws on
  // a length mismatch instead of answering false.
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString()) as CollabTokenPayload & {
      exp: number;
    };
    // `exp` is checked for presence before being compared: an absent one makes
    // `parsed.exp * 1000` NaN, and `NaN < Date.now()` is false — so a token
    // with no expiry read as "not expired" and lived forever. Nothing this
    // module signs omits it, so that needed the signing key to reach; a
    // credential that never expires is still exactly the property this format
    // exists to remove, and it must not be representable.
    if (!parsed.userId || !parsed.docName) return null;
    if (typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp)) return null;
    if (parsed.exp * 1000 < Date.now()) return null;
    if (parsed.docName !== expectedDocName) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The connection context a verified token stands for. */
export function tokenContext(payload: CollabTokenPayload): CollabConnectionContext {
  return {
    userId: payload.userId,
    ...(payload.user ? { user: payload.user } : {}),
  };
}

/**
 * Verifies a self-hosted token against the key resolved from the app —
 * what a driver's handshake calls.
 *
 * Throws (rather than returning `null`) when there is no key to verify
 * against: a missing secret is a misconfiguration of the server, not a bad
 * token from the client, and the two must not produce the same message in the
 * logs. Either way nothing is authenticated.
 */
export async function verifySelfHostedToken(
  token: string,
  docName: string,
  source: CollabTokenSecret | undefined,
): Promise<CollabConnectionContext | null> {
  const secret = await resolveTokenSecret(source);
  const payload = verifyCollabToken(token, secret, docName);
  return payload ? tokenContext(payload) : null;
}

/**
 * Signs the edge JWT. Same format and same TTL as every other collaboration
 * token; the difference is the key, which the PartyKit worker holds
 * (`COLLAB_JWT_SECRET`) and this process only shares with it.
 */
export const signPartyKitToken = signCollabToken;

/**
 * Verifies an edge JWT, including its document binding.
 *
 * The worker template runs the same three checks in WebCrypto — signature,
 * `exp`, and `docName` against the room being connected to. Keep them in
 * step: the room is the document, so a token that opens a room it was not
 * issued for is the same hole on the edge that it is here.
 */
export const verifyPartyKitToken = verifyCollabToken;

/** Builds the browser-facing WebSocket URL for an engine. */
export function buildWsUrl(config: TokenIssuerConfig, docName: string): string {
  if (config.engine === 'partykit') {
    const { roomHost, party } = config.partykit ?? {};
    const scheme =
      roomHost?.startsWith('localhost') || roomHost?.startsWith('127.0.0.1') ? 'ws' : 'wss';
    const host = roomHost?.replace(/^https?:\/\//, '') ?? '';
    return `${scheme}://${host}/parties/${party ?? 'main'}/${encodeURIComponent(docName)}`;
  }
  return config.path ?? '/collaboration';
}

/** Result of a successful token issue. */
export interface IssuedToken {
  token: string;
  wsUrl: string;
  engine: string;
  /**
   * Epoch milliseconds after which the credential stops being accepted.
   *
   * Reported for every engine: both wire formats are signed JWTs with an
   * `exp`, and the handshake refuses a token past it. (It was absent for the
   * self-hosted format while that format had no expiry — an unsigned claim
   * about identity that never died. It is a real credential now.)
   *
   * It exists for the benefit of a token handed to the browser *before* it
   * connects (a server-rendered page prop). Such a token can sit in the HTML
   * for as long as the tab is open, and the client has to be able to tell
   * "already dead" from "worth trying" without opening a socket to find out.
   *
   * Optional on the type because a custom issuer may not have one to report;
   * nothing this package issues omits it.
   */
  expiresAt?: number;
}

/** Thrown when authorize() denies read access for the document. */
export class CollabForbiddenError extends Error {
  constructor(docName: string, message?: string) {
    super(message ?? `no access to document "${docName}"`);
    this.name = 'CollabForbiddenError';
  }
}

/**
 * Thrown when the permission rule itself could not be evaluated — a broken
 * `authorize`, or a database the rule needs and cannot reach.
 *
 * Distinct from {@link CollabForbiddenError} on purpose: "you may not" is a
 * final answer a client should respect, while "we could not tell" is a
 * transient condition it may retry. Collapsing the two is what turns an app's
 * database blip into an unbounded reconnect storm.
 */
export class CollabAuthorizationError extends Error {
  constructor(
    readonly docName: string,
    override readonly cause?: unknown,
  ) {
    super(`could not evaluate access to document "${docName}"`);
    this.name = 'CollabAuthorizationError';
  }
}

/**
 * Issues an ephemeral credential for `docName`, enforcing the permission
 * seam via `authorize`.
 *
 * **Fails closed without a rule.** Skipping the check when `authorize` is
 * absent handed any authenticated caller a token for any document; an absent
 * rule is a misconfiguration, not a grant.
 */
export async function issueToken(
  config: TokenIssuerConfig,
  user: { id: string; name?: string | null },
  docName: string,
  authorize?: AuthorizeFn,
): Promise<IssuedToken> {
  const ctx: CollabConnectionContext = {
    userId: user.id,
    ...(user.name ? { user: { name: user.name } } : {}),
  };

  if (!authorize) {
    throw new CollabForbiddenError(
      docName,
      `no authorize rule configured — refusing to issue a token for "${docName}". Set authorize in config/collaboration.ts, or pass one to collaborationRoutes().`,
    );
  }
  const permission: CollabPermission = await authorize(ctx, docName);
  if (!permission.canRead) throw new CollabForbiddenError(docName);

  if (config.engine === 'partykit') {
    if (!config.partykit?.jwtSecret) {
      throw new Error('config.partykit.jwtSecret is required when engine=partykit');
    }
    return {
      token: signPartyKitToken({ userId: user.id, docName }, config.partykit.jwtSecret),
      wsUrl: buildWsUrl(config, docName),
      engine: config.engine,
      expiresAt: Date.now() + COLLAB_TOKEN_TTL_SECONDS * 1000,
    };
  }

  // Self-hosted. Signed with the app's key, bound to this document and dead
  // in five minutes — resolved before anything is returned, so a server with
  // no key configured refuses to issue rather than handing out a credential
  // its own handshake will reject.
  const secret = await resolveTokenSecret(config.tokenSecret);
  return {
    token: signCollabToken(
      { userId: user.id, docName, ...(ctx.user ? { user: ctx.user } : {}) },
      secret,
    ),
    wsUrl: buildWsUrl(config, docName),
    engine: config.engine,
    expiresAt: Date.now() + COLLAB_TOKEN_TTL_SECONDS * 1000,
  };
}
