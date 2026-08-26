import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CollabConnectionContext, CollabPermission, PartyKitConfig } from '../types.js';

/**
 * The token/auth module — the single seam for issuing and verifying
 * collaboration credentials.
 *
 * Two wire formats, chosen by engine:
 *  - `partykit` → HS256 JWT (verified by the edge worker via WebCrypto)
 *  - self-hosted (`yjs`/`automerge`) → legacy base64 JSON payload accepted
 *    by the driver handshake
 *
 * `issueToken` also enforces `config.authorize` on the REST path — the
 * permission seam must hold outside the WebSocket handshake too.
 */

export interface TokenIssuerConfig {
  engine: string;
  /** WS path of the embedded Hocuspocus server (self-hosted engines). */
  path?: string;
  partykit?: Partial<Pick<PartyKitConfig, 'roomHost' | 'jwtSecret' | 'party'>>;
}

/** Minimal authorize contract — mirrors CollaborationConfig.authorize. */
export type AuthorizeFn = (
  ctx: CollabConnectionContext,
  docName: string,
) => Promise<CollabPermission>;

/** Signs a minimal HS256 JWT — no external dependency. */
export function signPartyKitToken(
  payload: { userId: string; docName: string; user?: { name?: string; avatarUrl?: string | null } },
  secret: string,
  expiresInSeconds = 300,
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSeconds };
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode(header)}.${encode(body)}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

/** Verifies signature + expiry of a token issued by {@link signPartyKitToken}. */
export function verifyPartyKitToken(
  token: string,
  secret: string,
): { userId: string; docName: string; exp: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
      userId: string;
      docName: string;
      exp: number;
    };
    if (!parsed.userId || !parsed.docName || parsed.exp * 1000 < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Parses the legacy base64 payload used by self-hosted driver handshakes. */
export function parseLegacyToken(token: string): CollabConnectionContext | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64').toString()) as CollabConnectionContext;
    return parsed.userId ? parsed : null;
  } catch {
    return null;
  }
}

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
}

/** Thrown when authorize() denies read access for the document. */
export class CollabForbiddenError extends Error {
  constructor(docName: string) {
    super(`no access to document "${docName}"`);
    this.name = 'CollabForbiddenError';
  }
}

/**
 * Issues an ephemeral credential for `docName`, enforcing the permission
 * seam via `authorize` when one is provided.
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

  let permission: CollabPermission | undefined;
  if (authorize) {
    permission = await authorize(ctx, docName);
    if (!permission.canRead) throw new CollabForbiddenError(docName);
  }

  if (config.engine === 'partykit') {
    if (!config.partykit?.jwtSecret) {
      throw new Error('config.partykit.jwtSecret is required when engine=partykit');
    }
    return {
      token: signPartyKitToken({ userId: user.id, docName }, config.partykit.jwtSecret),
      wsUrl: buildWsUrl(config, docName),
      engine: config.engine,
    };
  }

  return {
    token: Buffer.from(JSON.stringify(ctx)).toString('base64'),
    wsUrl: buildWsUrl(config, docName),
    engine: config.engine,
  };
}
