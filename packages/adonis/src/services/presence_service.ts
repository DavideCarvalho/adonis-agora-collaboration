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
/** How often a live instance re-stamps the members it holds. */
const REFRESH_INTERVAL_MS = (TTL_SECONDS * 1000) / 3;

/**
 * Drops the members whose stamp is older than the cutoff — read again inside
 * the script, so a member re-stamped since the list read stays.
 * KEYS: members hash, stamps zset. ARGV: cutoff, then the user ids.
 */
const PRUNE_SCRIPT = `
local removed = 0
for i = 2, #ARGV do
  local seen = redis.call('ZSCORE', KEYS[2], ARGV[i])
  if seen and tonumber(seen) < tonumber(ARGV[1]) then
    redis.call('HDEL', KEYS[1], ARGV[i])
    redis.call('ZREM', KEYS[2], ARGV[i])
    removed = removed + 1
  end
end
return removed
`;

/**
 * Redis-backed presence store. One hash of members per document, plus a
 * sorted set stamping when each member was last confirmed. A member whose
 * stamp is older than the TTL is not listed (and is pruned on the read), so
 * the users of an instance that died without running its disconnects drop
 * out even while others keep the document busy. Every live instance
 * re-stamps the members it holds on an interval, which keeps them listed
 * for as long as they stay connected. A member with no stamp is governed by
 * the TTL of the whole key alone.
 */
export class RedisPresenceStore implements PresenceStore {
  /** Members joined through this instance, by document and user. */
  private readonly local = new Map<string, Map<string, PresenceMember>>();
  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly redis: Redis) {}

  private key(docName: string): string {
    return `collab:presence:${docName}`;
  }

  private seenKey(docName: string): string {
    return `collab:presence:${docName}:seen`;
  }

  async join(docName: string, member: PresenceMember): Promise<void> {
    let members = this.local.get(docName);
    if (!members) {
      members = new Map();
      this.local.set(docName, members);
    }
    members.set(member.userId, member);
    this.startRefreshing();
    await this.stamp(docName, [member]);
  }

  async leave(docName: string, userId: string): Promise<void> {
    const members = this.local.get(docName);
    members?.delete(userId);
    if (members?.size === 0) this.local.delete(docName);
    if (this.local.size === 0) this.stopRefreshing();
    await this.redis
      .multi()
      .hdel(this.key(docName), userId)
      .zrem(this.seenKey(docName), userId)
      .exec();
  }

  async list(docName: string): Promise<PresenceMember[]> {
    const key = this.key(docName);
    const seenKey = this.seenKey(docName);
    const results = await this.redis
      .multi()
      .hgetall(key)
      .zrange(seenKey, '0', '-1', 'WITHSCORES')
      .exec();
    const entries = (results?.[0]?.[1] ?? {}) as Record<string, string>;
    const stamps = (results?.[1]?.[1] ?? []) as string[];

    const seen = new Map<string, number>();
    for (let i = 0; i < stamps.length; i += 2) seen.set(stamps[i]!, Number(stamps[i + 1]));

    const cutoff = Date.now() - TTL_SECONDS * 1000;
    const members: PresenceMember[] = [];
    const expired: string[] = [];
    for (const [userId, value] of Object.entries(entries)) {
      const stampedAt = seen.get(userId);
      if (stampedAt !== undefined && stampedAt < cutoff) {
        expired.push(userId);
        continue;
      }
      try {
        members.push(JSON.parse(value) as PresenceMember);
      } catch {
        // Entrada corrompida/parcial — ignora.
      }
    }
    if (expired.length > 0) {
      await this.redis.eval(PRUNE_SCRIPT, 2, key, seenKey, String(cutoff), ...expired);
    }
    return members;
  }

  async close(): Promise<void> {
    this.stopRefreshing();
    await this.redis.quit();
  }

  /** Writes `members` with a fresh stamp and extends both keys' TTL. */
  private async stamp(docName: string, members: PresenceMember[]): Promise<void> {
    const key = this.key(docName);
    const seenKey = this.seenKey(docName);
    const now = Date.now();
    const pipeline = this.redis.multi();
    for (const member of members) {
      pipeline.hset(key, member.userId, JSON.stringify(member));
      pipeline.zadd(seenKey, now, member.userId);
    }
    await pipeline.expire(key, TTL_SECONDS).expire(seenKey, TTL_SECONDS).exec();
  }

  private startRefreshing(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  private stopRefreshing(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  /** Re-stamps every member this instance holds, so they outlive the TTL while connected. */
  private async refresh(): Promise<void> {
    await Promise.all(
      [...this.local].map(([docName, members]) =>
        this.stamp(docName, [...members.values()]).catch(() => {
          // A failed refresh is retried on the next tick; expiry only needs one to land.
        }),
      ),
    );
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
