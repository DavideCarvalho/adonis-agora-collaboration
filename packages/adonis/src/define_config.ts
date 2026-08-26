import type { ResolveUserFn } from './http/types.js';
import type { CollaborationConfig, PartyKitConfig } from './types.js';

/**
 * Shape of the `config/collaboration.ts` published by the stub — the
 * "app-friendly" version of {@link CollaborationConfig} (redisUrl as a
 * string, optional storage).
 */
export type CollaborationAppConfig = {
  engine?: CollaborationConfig['engine'];
  path?: string;
  redisUrl?: string;
  debounce?: number;
  authorize: CollaborationConfig['authorize'];
  /** Omitted = in-memory (dev only). Production passes a persistent storage. */
  storage?: CollaborationConfig['storage'];
  /** Required when engine = 'partykit' (edge sync). */
  partykit?: PartyKitConfig;
  /**
   * Built-in REST endpoints. Registered automatically by the provider
   * unless `enabled: false` — then call `collaborationRoutes(router)`
   * inside `start/routes.ts` and apply your own middleware.
   */
  routes?: {
    /** Default: true. */
    enabled?: boolean;
    /** Default: '/collaboration'. */
    prefix?: string;
    /** Middleware applied to the whole route group (manual mode too). */
    middleware?: unknown[];
    /** Resolves the authenticated user for the token endpoint. */
    resolveUser?: ResolveUserFn;
  };
};

/**
 * Type-safe config helper used in the app's `config/collaboration.ts` —
 * same pattern as @adonisjs/*'s `defineConfig`.
 */
export function defineConfig(config: CollaborationAppConfig): CollaborationAppConfig {
  return config;
}
