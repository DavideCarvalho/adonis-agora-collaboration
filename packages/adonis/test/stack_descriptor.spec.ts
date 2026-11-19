import { describe, expect, it } from 'vitest';
import { defineConfig } from '../src/define_config.js';
import { collaborationStackUses, STACK_DESCRIPTOR } from '../src/stack.js';
import { withCodec } from '../src/storage/codec.js';
import { FileSystemStorage } from '../src/storage/file_system_storage.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';
import { LucidStorage } from '../src/storage/lucid_storage.js';

const usesOf = (value: object): unknown => (value as Record<symbol, unknown>)[STACK_DESCRIPTOR];

function appConfig(values: Record<string, unknown>) {
  return {
    get(key: string) {
      let v: unknown = values;
      for (const part of key.split('.')) v = (v as Record<string, unknown> | undefined)?.[part];
      return v;
    },
  };
}

const fakeDb = { connection: () => ({}) } as never;

describe('stack descriptor', () => {
  it('describes a Lucid storage and a redisUrl on the config, non-enumerable', () => {
    const config = defineConfig({
      storage: new LucidStorage(fakeDb, { connection: 'educacao' }),
      redisUrl: 'redis://:secret@redis.internal:6380/2',
    });
    expect(usesOf(config)).toEqual([
      { tech: 'sql', connection: 'educacao', purpose: 'documents' },
      { tech: 'redis', label: 'redis', purpose: 'presence', host: 'redis.internal:6380/2' },
    ]);
    expect(Object.getOwnPropertyDescriptor(config, STACK_DESCRIPTOR)?.enumerable).toBe(false);
  });

  it('describes nothing for the in-memory storage', () => {
    expect(usesOf(defineConfig({ storage: new InMemoryCollaborationStorage() }))).toEqual([]);
  });

  it('describes a file-system storage, through a codec', () => {
    const config = defineConfig({
      storage: withCodec(new FileSystemStorage('/srv/app/.collab-data'), {
        encode: (v: Uint8Array) => v,
        decode: (v: Uint8Array) => v,
      } as never),
    });
    expect(usesOf(config)).toEqual([
      { tech: 'fs', label: '.collab-data', host: '/srv/app/.collab-data', purpose: 'documents' },
    ]);
  });

  it('resolves the default Lucid connection and matches redisUrl to a config/redis.ts connection', () => {
    const config = defineConfig({
      storage: new LucidStorage(fakeDb),
      redisUrl: 'redis://redis.internal:6379',
      partykit: { roomHost: 'app.partykit.dev' },
    });
    const app = appConfig({
      database: { connection: 'pg', connections: { pg: { client: 'pg' } } },
      redis: {
        connections: {
          cache: { host: 'redis.internal', port: 6379, db: 1 },
          main: { host: 'redis.internal', port: 6379, db: 0 },
        },
      },
    });
    expect(collaborationStackUses(config, app)).toEqual([
      { tech: 'postgres', connection: 'pg', purpose: 'documents' },
      { tech: 'redis', connection: 'main', purpose: 'presence' },
      { tech: 'partykit', label: 'partykit', host: 'app.partykit.dev', purpose: 'sync' },
    ]);
  });
});
