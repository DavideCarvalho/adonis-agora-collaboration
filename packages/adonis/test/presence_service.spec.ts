import { describe, expect, it } from 'vitest';
import {
  type PresenceMember,
  PresenceService,
  type PresenceStore,
} from '../src/services/presence_service.js';

class FakeStore implements PresenceStore {
  data = new Map<string, Map<string, string>>();
  async join(docName: string, member: PresenceMember): Promise<void> {
    if (!this.data.has(docName)) this.data.set(docName, new Map());
    this.data.get(docName)!.set(member.userId, JSON.stringify(member));
  }
  async leave(docName: string, userId: string): Promise<void> {
    this.data.get(docName)?.delete(userId);
  }
  async list(docName: string): Promise<PresenceMember[]> {
    const doc = this.data.get(docName) ?? new Map();
    return [...doc.values()].map((v) => JSON.parse(v) as PresenceMember);
  }
  async close(): Promise<void> {}
}

describe('PresenceService', () => {
  it('joins, lists and leaves members per document', async () => {
    const store = new FakeStore();
    const presence = new PresenceService(store);

    await presence.join('researches/1/writing', { userId: 'u1', name: 'Ana' });
    await presence.join('researches/1/writing', { userId: 'u2' });
    await presence.join('researches/2/writing', { userId: 'u3' });

    const doc1 = await presence.list('researches/1/writing');
    expect(doc1).toHaveLength(2);
    expect(doc1.find((m) => m.userId === 'u1')?.name).toBe('Ana');

    await presence.leave('researches/1/writing', 'u1');
    expect(await presence.list('researches/1/writing')).toHaveLength(1);

    // Docs são isolados entre si.
    expect(await presence.list('researches/2/writing')).toHaveLength(1);
  });
});
