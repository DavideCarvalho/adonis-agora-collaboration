import type { AuthorizeFn } from '../auth/token.js';
import type { CollabPermission } from '../types.js';

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
  /**
   * Present when @adonisjs/auth is installed. `user` is only populated once
   * the guard actually ran, so the default resolver calls `check()` (or
   * `authenticate()`) itself before reading it.
   */
  auth?: {
    user?: unknown;
    isAuthenticated?: boolean;
    check?(): Promise<boolean>;
    authenticate?(): Promise<unknown>;
  };
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
  engineFor?(options: { docName: string }): Promise<string>;
  /**
   * The app's permission rule, resolved exactly as the WebSocket handshake
   * resolves it (declared document first, then the global rule, then deny).
   * The routes fall back to this when no explicit `authorize` option is
   * given — which is what makes manual registration enforce the same rule
   * the provider does.
   */
  authorize?(
    ctx: { userId: string; user?: { name?: string; avatarUrl?: string | null } },
    docName: string,
  ): Promise<CollabPermission>;
  getDocumentState(options: { docName: string }): Promise<Uint8Array>;
  createVersion(options: {
    docName: string;
    createdBy: string | null;
    label?: string | null;
  }): Promise<unknown>;
  listVersions(options: { docName: string }): Promise<unknown[]>;
  restoreVersion(options: {
    docName: string;
    versionId: string;
    restoredBy: string | null;
  }): Promise<void>;
  persistDocument?(options: { docName: string; state: Uint8Array }): Promise<void>;
  comments: {
    list(docName: string, space?: string): Promise<unknown[]>;
    get(docName: string, commentId: string): Promise<unknown>;
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
