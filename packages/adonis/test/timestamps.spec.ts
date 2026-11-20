import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CollaborationManager } from '../src/collaboration_manager.js';
import { CommentService } from '../src/services/comment_service.js';
import { FileSystemStorage } from '../src/storage/file_system_storage.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';
import { toDateOrNull } from '../src/storage/shared.js';
import { TEST_TOKEN_SECRET } from './helpers/token.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const allow = async () => ({ canRead: true, canWrite: true, canComment: true }) as const;

describe('document created/updated timestamps', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('the memory storage keeps createdAt and moves updatedAt on each save', async () => {
    const storage = new InMemoryCollaborationStorage();
    await storage.saveDocument('docs/1', new Uint8Array([1]));
    const first = await storage.loadDocument('docs/1');
    expect(first?.createdAt).toBeInstanceOf(Date);
    expect(first?.updatedAt?.getTime()).toBe(first?.createdAt?.getTime());

    await tick();
    await storage.saveDocument('docs/1', new Uint8Array([2]));
    const second = await storage.loadDocument('docs/1');
    expect(second?.createdAt?.getTime()).toBe(first?.createdAt?.getTime());
    expect(second?.updatedAt?.getTime()).toBeGreaterThan(first?.updatedAt?.getTime() ?? 0);
  });

  it('the file storage reports the file times', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-ts-'));
    dirs.push(dir);
    const storage = new FileSystemStorage(dir);
    await storage.saveDocument('docs/1', new Uint8Array([1]));
    const stored = await storage.loadDocument('docs/1');
    expect(stored?.updatedAt).toBeInstanceOf(Date);
    expect(stored?.createdAt === null || stored?.createdAt instanceof Date).toBe(true);
  });

  it('describeDocument answers ISO dates, and null for a document never stored', async () => {
    const storage = new InMemoryCollaborationStorage();
    const manager = new CollaborationManager({
      engine: 'yjs',
      authorize: allow,
      tokenSecret: TEST_TOKEN_SECRET,
      storage,
    });
    try {
      expect(await manager.describeDocument({ docName: 'docs/none' })).toMatchObject({
        createdAt: null,
        updatedAt: null,
      });
      await storage.saveDocument('docs/1', new Uint8Array([1]));
      const described = await manager.describeDocument({ docName: 'docs/1' });
      expect(described.createdAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
      expect(described.updatedAt).toBe(described.createdAt);
    } finally {
      await manager.close();
    }
  });
});

describe('comment created/updated timestamps', () => {
  it('a new comment starts with updatedAt = createdAt; resolving moves only updatedAt', async () => {
    const comments = new CommentService(new InMemoryCollaborationStorage());
    const created = await comments.create('docs/1', {
      documentName: 'docs/1',
      space: 'text',
      anchor: { kind: 'timestamp', at: 0 },
      body: 'hi',
      userId: 'u1',
    });
    expect(created.updatedAt).toBe(created.createdAt);

    await tick();
    const resolved = await comments.resolve('docs/1', created.id, true);
    expect(resolved?.createdAt).toBe(created.createdAt);
    expect(Date.parse(resolved?.updatedAt ?? '')).toBeGreaterThan(Date.parse(created.createdAt));
  });
});

describe('toDateOrNull', () => {
  it('normalises Date, ISO strings, epoch ms and Luxon-like values', () => {
    const at = new Date('2026-11-20T10:00:00.000Z');
    expect(toDateOrNull(at)).toEqual(at);
    expect(toDateOrNull(at.toISOString())).toEqual(at);
    expect(toDateOrNull(at.getTime())).toEqual(at);
    expect(toDateOrNull({ toJSDate: () => at })).toEqual(at);
    expect(toDateOrNull(null)).toBeNull();
    expect(toDateOrNull('nope')).toBeNull();
  });
});
