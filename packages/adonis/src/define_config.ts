import type { CollaborationConfig } from './types.js';

/**
 * Config helper (type-safe) usado no `config/collaboration.ts` do app —
 * mesmo padrão do `defineConfig` do @adonisjs/*.
 */
export function defineConfig(config: {
  engine?: CollaborationConfig['engine'];
  path?: string;
  redisUrl?: string;
  debounce?: number;
  authorize: CollaborationConfig['authorize'];
  storage?: CollaborationConfig['storage'];
}): CollaborationAppConfig {
  return config as CollaborationAppConfig;
}

/** Shape publicado no stub de config (sem storage obrigatório). */
export type CollaborationAppConfig = {
  engine?: 'yjs' | 'automerge';
  path?: string;
  redisUrl?: string;
  debounce?: number;
  authorize: CollaborationConfig['authorize'];
  /** Omitido = storage em disco (.collab-data), útil só em dev. */
  storage?: CollaborationConfig['storage'];
};
