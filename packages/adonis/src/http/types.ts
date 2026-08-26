import type { AuthorizeFn } from '../auth/token.js';

/**
 * Minimal HttpContext contract consumed by the built-in route handlers.
 * Intentionally structural — keeps the package decoupled from the full
 * @adonisjs/core/http surface across versions.
 */
export interface CollabHttpContext {
  request: {
    qs(): Record<string, unknown>;
    params: Record<string, unknown>;
    body<T = Record<string, unknown>>(): T;
    raw(): ArrayBuffer | undefined;
    header(name: string): string | undefined;
  };
  response: {
    status(code: number): { json(payload: unknown): unknown };
    json(payload: unknown): unknown;
    send(payload: unknown): unknown;
    noContent(): unknown;
    header(name: string, value: string): unknown;
  };
  /** Present when @adonisjs/auth is installed and its middleware ran. */
  auth?: { user?: unknown };
}

/** Authenticated user resolved by the token endpoint. */
export interface CollabRouteUser {
  id: string;
  name?: string | null;
}

/** User resolver — pluggable via config or manual route mode. */
export type ResolveUserFn = (
  ctx: CollabHttpContext,
) => Promise<CollabRouteUser | null> | CollabRouteUser | null;

/** Internal error signaling a 401 without leaking details. */
export class CollabUnauthorizedError extends Error {
  constructor(message = 'unauthenticated') {
    super(message);
    this.name = 'CollabUnauthorizedError';
  }
}

/**
 * CollaborationManager surface consumed by the built-in routes.
 * Structural: accepts the real manager and test fakes alike.
 */
export interface CollabManagerLike {
  /** Per-document engine resolution (used by the token endpoint). */
  engineFor?(docName: string): Promise<string>;
  getDocumentState(docName: string): Promise<Uint8Array>;
  createVersion(docName: string, createdBy: string | null, label: string | null): Promise<unknown>;
  listVersions(docName: string): Promise<unknown[]>;
  restoreVersion(docName: string, versionId: string, restoredBy: string | null): Promise<void>;
  persistDocument?(docName: string, state: Uint8Array): Promise<void>;
  comments: {
    list(docName: string, space?: string): Promise<unknown[]>;
    create(docName: string, comment: Record<string, unknown>): Promise<unknown>;
    resolve(docName: string, commentId: string, resolved: boolean): Promise<unknown>;
    remove(docName: string, commentId: string): Promise<boolean>;
  };
}

/**
 * Runtime pieces resolved once and captured by the route handlers.
 * The provider fills these from config; manual mode may omit any and the
 * lib falls back to reading `config/collaboration.ts` at request time.
 */
export interface CollabRoutesRuntime {
  prefix?: string;
  middleware?: unknown[];
  resolveUser?: ResolveUserFn;
  /** Enforced on token issue — the permission seam must hold on REST too. */
  authorize?: AuthorizeFn;
  /** Manager accessor; defaults to the booted container singleton. */
  manager?: CollabManagerLike | (() => Promise<CollabManagerLike> | CollabManagerLike);
  engine?: string;
  /** WS path of the embedded Hocuspocus server (default '/collaboration'). */
  path?: string;
  partykit?: { roomHost?: string; jwtSecret?: string; party?: string };
}
