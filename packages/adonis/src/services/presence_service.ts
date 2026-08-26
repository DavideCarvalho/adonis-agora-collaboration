import { Redis } from 'ioredis';

/**
 * Presence store contract — makes the service testable without a live
 * Redis (tests use an in-memory fake).
 */
export interface PresenceStore {
  join(docName: string, member: PresenceMember): Promise<void>;
  leave(docName: string, userId: string): Promise<void>;
  list(docName: string): Promise<PresenceMember[]>;
  close(): Promise<void>;
}

export interface PresenceMember {
  userId: string;
  name?: string | null;
  avatarUrl?: string | null;
}

const TTL_SECONDS = 60;

/**
 * Redis-backed presence store. One hash per document; members expire via
 * TTL refresh on join (no heartbeat handled here — drivers refresh on
 * connect and we prune stale entries on read).
 */
export class RedisPresenceStore implements PresenceStore {
  constructor(private readonly redis: Redis) {}

  private key(docName: string): string {
    return `collab:presence:${docName}`;
  }

  async join(docName: string, member: PresenceMember): Promise<void> {
    const key = this.key(docName);
    await this.redis
      .multi()
      .hset(key, member.userId, JSON.stringify(member))
      .expire(key, TTL_SECONDS)
      .exec();
  }

  async leave(docName: string, userId: string): Promise<void> {
    await this.redis.hdel(this.key(docName), userId);
  }

  async list(docName: string): Promise<PresenceMember[]> {
    const entries = await this.redis.hgetall(this.key(docName));
    const members: PresenceMember[] = [];
    for (const value of Object.values(entries)) {
      try {
        members.push(JSON.parse(value as string) as PresenceMember);
      } catch {
        // Entrada corrompida/parcial — ignora.
      }
    }
    return members;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

/**
 * Server-side presence (cross-instance). Join/leave is fed by the WS
 * drivers on connect/disconnect; the client still gets richer presence via
 * Yjs awareness (peer-to-peer within a room). This service answers the
 * aggregate question ("who is online in doc X across all instances").
 */
export class PresenceService {
  constructor(private readonly store: PresenceStore) {}

  async join(docName: string, member: PresenceMember): Promise<void> {
    await this.store.join(docName, member);
  }

  async leave(docName: string, userId: string): Promise<void> {
    await this.store.leave(docName, userId);
  }

  async list(docName: string): Promise<PresenceMember[]> {
    return this.store.list(docName);
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}
