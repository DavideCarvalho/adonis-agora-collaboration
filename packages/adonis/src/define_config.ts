import type { ResolveUserFn } from './http/types.js';
import type { CollaborationConfig, PartyKitConfig } from './types.js';

/**
 * Shape of the `config/collaboration.ts` published by the stub — the
 * "app-friendly" version of {@link CollaborationConfig} (redisUrl as a
 * string, optional storage).
 */
export type CollaborationAppConfig = {
  engine?: CollaborationConfig['engine'];
  engineFor?: CollaborationConfig['engineFor'];
  documents?: CollaborationConfig['documents'];
  path?: string;
  redisUrl?: string;
  debounce?: number;
  authorize?: CollaborationConfig['authorize'];
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
 *
 * Generic over the literal config so the **keys of `documents` survive**.
 * Returning the widened `CollaborationAppConfig` collapsed them to `string`,
 * which is why there was no way to get a union of declared document names out
 * of the config and every call site hand-built doc-name strings. See
 * {@link InferCollabDocumentNames}.
 */
export function defineConfig<T extends CollaborationAppConfig>(config: T): T {
  return config;
}

/**
 * The union of document-name patterns declared in `config/collaboration.ts`.
 *
 * ```ts
 * // types/collaboration.ts
 * import type { InferCollabDocumentNames } from '@adonis-agora/collaboration'
 * import collaborationConfig from '#config/collaboration'
 *
 * export type CollabDocumentName = InferCollabDocumentNames<typeof collaborationConfig>
 * //   → 'researches/:id/writing' | 'whiteboards/:id'
 * ```
 *
 * The patterns keep their `:param` segments — they are the declaration, not a
 * resolved name. Build a concrete name from one with
 * {@link CollabDocumentNameFor} when you want the parameters checked too.
 */
export type InferCollabDocumentNames<T> = T extends { documents: infer D }
  ? Extract<keyof D, string>
  : never;

/**
 * A declared pattern with its `:params` replaced by strings — so
 * `'researches/:id/writing'` accepts `` `researches/${string}/writing` `` and
 * rejects a typo'd `'research/42/writing'`.
 */
export type CollabDocumentNameFor<Pattern extends string> =
  Pattern extends `${infer Head}/:${infer Rest}`
    ? Rest extends `${string}/${infer Tail}`
      ? `${Head}/${string}/${CollabDocumentNameFor<Tail>}`
      : `${Head}/${string}`
    : Pattern;
