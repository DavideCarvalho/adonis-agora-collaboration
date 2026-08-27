import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * The integration suite: real Postgres in a throwaway container, the real published
 * migrations, the real `LucidStorage`. Split from `vitest.config.ts` so `pnpm test` stays
 * fast and runs without Docker, while `pnpm test:integration` proves the half a unit test
 * structurally cannot — that the SQL the storage emits is valid and deletes exactly the
 * rows it claims.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    globals: true,
    include: ['test/integration/**/*.{spec,test}.ts'],
    globalSetup: ['test/integration/global_setup.ts'],
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
