import { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisPresenceStore } from '../../src/services/presence_service.js';

/**
 * The Redis presence roster against a real Redis.
 *
 * Every instance writes its members into one hash per document. A member must
 * drop out of the roster once nobody has confirmed it for the TTL — even on a
 * document other instances keep busy — and must stay in it, however long,
 * while the instance holding it is alive.
 */

const url = process.env.COLLAB_TEST_REDIS_URL;
if (!url) throw new Error('COLLAB_TEST_REDIS_URL is not set — run through test:integration');

const DOC = 'researches/42/writing';
const HASH = `collab:presence:${DOC}`;

let admin: Redis;
const stores: RedisPresenceStore[] = [];
const instance = () => {
  const store = new RedisPresenceStore(new Redis(url));
  stores.push(store);
  return store;
};

beforeEach(async () => {
  admin = new Redis(url);
  await admin.flushall();
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(stores.splice(0).map((store) => store.close()));
  await admin.quit();
});

const ids = async (store: RedisPresenceStore) =>
  (await store.list(DOC)).map((member) => member.userId).sort();

describe('RedisPresenceStore', () => {
  it('joins, lists and leaves', async () => {
    const store = instance();
    await store.join(DOC, { userId: 'u_1', name: 'Ana' });
    await store.join(DOC, { userId: 'u_2' });

    expect(await store.list(DOC)).toEqual(
      expect.arrayContaining([{ userId: 'u_1', name: 'Ana' }, { userId: 'u_2' }]),
    );
    await store.leave(DOC, 'u_1');
    expect(await ids(store)).toEqual(['u_2']);
  });

  it('drops the members of a dead instance while a live one keeps the document busy', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const dead = instance();
    const live = instance();

    await dead.join(DOC, { userId: 'u_dead' });
    // The process dies: no disconnects run, nothing re-stamps its members.
    await dead.close();

    // The live instance keeps joining people for three minutes.
    for (let minute = 0; minute < 3; minute++) {
      await live.join(DOC, { userId: `u_live_${minute}` });
      await vi.advanceTimersByTimeAsync(60_000);
    }

    expect(await ids(live)).toEqual(['u_live_0', 'u_live_1', 'u_live_2']);
    // Pruned, not merely hidden.
    expect(await admin.hexists(HASH, 'u_dead')).toBe(0);
  });

  it('keeps a connected member listed past the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const store = instance();
    await store.join(DOC, { userId: 'u_1' });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await ids(store)).toEqual(['u_1']);
  });

  it('puts a connected member back when its entry expired or another instance removed it', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const store = instance();
    const other = instance();
    await store.join(DOC, { userId: 'u_1', name: 'Ana' });

    // The key ran out (or another instance's last tab of u_1 just closed).
    await other.leave(DOC, 'u_1');
    await admin.del(HASH);
    expect(await ids(store)).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(await store.list(DOC)).toEqual([{ userId: 'u_1', name: 'Ana' }]);
    expect(await admin.ttl(HASH)).toBeGreaterThan(0);
  });

  it('stops re-stamping a member once it leaves', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const store = instance();
    await store.join(DOC, { userId: 'u_1' });
    await store.leave(DOC, 'u_1');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await ids(store)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lists entries written without a stamp', async () => {
    const store = instance();
    await admin.hset(HASH, 'u_plain', JSON.stringify({ userId: 'u_plain' }));
    await admin.expire(HASH, 60);

    expect(await ids(store)).toEqual(['u_plain']);
  });

  it('keeps the stored member format', async () => {
    const store = instance();
    await store.join(DOC, { userId: 'u_1', name: 'Ana' });

    expect(await admin.hgetall(HASH)).toEqual({
      u_1: JSON.stringify({ userId: 'u_1', name: 'Ana' }),
    });
  });
});
