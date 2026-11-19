import { basename } from 'node:path';
import { CodecStorage } from './storage/codec.js';
import { FileSystemStorage } from './storage/file_system_storage.js';
import { lucidStorageOf } from './storage/lucid_storage.js';

/**
 * What collaboration runs on, for telescope's Architecture page ("collaboration: documents →
 * PostgreSQL", "collaboration: presence → Redis main"). Telescope reads `config/collaboration.ts`
 * after boot and looks for a list of uses under the global symbol `@adonis-agora/stack`. No
 * dependency on telescope.
 */

/** The symbol telescope reads a lib's infrastructure under. */
export const STACK_DESCRIPTOR = Symbol.for('@adonis-agora/stack');

/** What collaboration uses (the shape telescope reads). */
export interface StackUse {
  tech: string;
  connection?: string;
  purpose?: string;
  label?: string;
  host?: string;
}

/** Attach `uses` to `target`, non-enumerable. Never throws (a frozen object stays undescribed). */
export function describeStackUse<T extends object>(target: T, uses: StackUse | StackUse[]): T {
  try {
    Object.defineProperty(target, STACK_DESCRIPTOR, {
      value: Array.isArray(uses) ? uses : [uses],
      enumerable: false,
      configurable: true,
    });
  } catch {
    // frozen: nothing to describe
  }
  return target;
}

interface AppConfigLike {
  get(key: string, defaultValue?: unknown): unknown;
}

const DB_TECH: Record<string, string> = {
  pg: 'postgres',
  postgres: 'postgres',
  postgresql: 'postgres',
  'pg-native': 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  'better-sqlite3': 'sqlite',
  sqlite3: 'sqlite',
  sqlite: 'sqlite',
  libsql: 'sqlite',
  mssql: 'mssql',
};

function read(appConfig: AppConfigLike | undefined, key: string): unknown {
  try {
    return appConfig?.get(key);
  } catch {
    return undefined;
  }
}

function storageUse(storage: unknown, appConfig: AppConfigLike | undefined): StackUse | undefined {
  const lucid = lucidStorageOf(storage);
  if (lucid) {
    const primary = read(appConfig, 'database.connection');
    const connection = lucid.connectionName ?? (typeof primary === 'string' ? primary : undefined);
    const client =
      connection !== undefined
        ? read(appConfig, `database.connections.${connection}.client`)
        : undefined;
    const tech = (typeof client === 'string' ? DB_TECH[client] : undefined) ?? 'sql';
    return { tech, ...(connection !== undefined ? { connection } : {}), purpose: 'documents' };
  }
  let current = storage;
  while (current instanceof CodecStorage) current = current.inner;
  if (current instanceof FileSystemStorage) {
    return {
      tech: 'fs',
      label: basename(current.directory),
      host: current.directory,
      purpose: 'documents',
    };
  }
  return undefined;
}

/** `host:port/db` of a Redis URL, or undefined when it does not parse. */
function redisTarget(url: string): { host: string; port: string; db: string } | undefined {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: u.port || '6379', db: u.pathname.replace(/^\//, '') || '0' };
  } catch {
    return undefined;
  }
}

/**
 * The `config/redis.ts` connection pointing at the same server and db as `url`, so presence links to
 * the Redis telescope already knows instead of a second node for the same server.
 */
function matchingRedisConnection(
  url: string,
  appConfig: AppConfigLike | undefined,
): string | undefined {
  const target = redisTarget(url);
  const connections = read(appConfig, 'redis.connections');
  if (!target || connections === null || typeof connections !== 'object') return undefined;
  for (const [name, raw] of Object.entries(connections as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') continue;
    const c = raw as { url?: unknown; host?: unknown; port?: unknown; db?: unknown };
    const other =
      typeof c.url === 'string'
        ? redisTarget(c.url)
        : {
            host: String(c.host ?? ''),
            port: String(c.port ?? '6379'),
            db: String(c.db ?? '0'),
          };
    if (
      other &&
      other.host === target.host &&
      other.port === target.port &&
      other.db === target.db
    ) {
      return name;
    }
  }
  return undefined;
}

interface DescribableConfig {
  storage?: unknown;
  redisUrl?: unknown;
  partykit?: { roomHost?: unknown } | undefined;
}

/**
 * What `config/collaboration.ts` runs on: its `storage` (documents), its `redisUrl` (presence) and
 * its PartyKit host (sync). `appConfig` (the app's config) resolves the default Lucid connection
 * and matches `redisUrl` to a `config/redis.ts` connection.
 */
export function collaborationStackUses(config: unknown, appConfig?: AppConfigLike): StackUse[] {
  if (config === null || typeof config !== 'object') return [];
  const c = config as DescribableConfig;
  const uses: StackUse[] = [];
  const storage = storageUse(c.storage, appConfig);
  if (storage) uses.push(storage);
  if (typeof c.redisUrl === 'string' && c.redisUrl.length > 0) {
    const connection = matchingRedisConnection(c.redisUrl, appConfig);
    const target = redisTarget(c.redisUrl);
    uses.push(
      connection !== undefined
        ? { tech: 'redis', connection, purpose: 'presence' }
        : {
            tech: 'redis',
            label: 'redis',
            purpose: 'presence',
            ...(target ? { host: `${target.host}:${target.port}/${target.db}` } : {}),
          },
    );
  }
  if (typeof c.partykit?.roomHost === 'string') {
    uses.push({ tech: 'partykit', label: 'partykit', host: c.partykit.roomHost, purpose: 'sync' });
  }
  return uses;
}
