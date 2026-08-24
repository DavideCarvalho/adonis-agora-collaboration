import type { CollaborationConfig } from './types.js';

/**
 * Shape do `config/collaboration.ts` publicado pelo stub — versão "app-friendly"
 * do {@link CollaborationConfig} (redisUrl como string, storage opcional).
 */
export type CollaborationAppConfig = {
  engine?: CollaborationConfig['engine'];
  path?: string;
  redisUrl?: string;
  debounce?: number;
  authorize: CollaborationConfig['authorize'];
  /** Omitido = in-memory (só dev). Produção passa um storage persistente. */
  storage?: CollaborationConfig['storage'];
};

/**
 * Config helper (type-safe) usado no `config/collaboration.ts` do app —
 * mesmo padrão do `defineConfig` do @adonisjs/*.
 */
export function defineConfig(config: CollaborationAppConfig): CollaborationAppConfig {
  return config;
}
