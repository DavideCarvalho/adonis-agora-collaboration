import * as A from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { AutomergeDriver } from '../src/drivers/automerge/automerge_driver.js';
import { YjsDriver } from '../src/drivers/yjs/yjs_driver.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';
import { TEST_TOKEN_SECRET } from './helpers/token.js';

/**
 * `CollaborationDriver.restoreVersion` promises, in so many words, to create a
 * new "restored from X" version. Both drivers did the opposite: `restoredBy`
 * was discarded (`void restoredBy;` / `_restoredBy`) and the live state was
 * overwritten and saved with nothing recording what it replaced.
 *
 * A restore is therefore the one operation in a *version history* that could
 * not be undone, and there was no trace of who ran it.
 */

const allow = async () => ({ canRead: true, canWrite: true, canComment: true }) as const;
const DOC = 'researches/42/writing';

describe('YjsDriver.restoreVersion', () => {
  async function seed() {
    const storage = new InMemoryCollaborationStorage();
    const write = async (text: string) => {
      const doc = new Y.Doc();
      doc.getText('content').insert(0, text);
      await storage.saveDocument(DOC, Y.encodeStateAsUpdate(doc));
    };
    return { storage, write };
  }

  it('records the replaced state as a new version, attributed to the restorer', async () => {
    const { storage, write } = await seed();
    const driver = new YjsDriver({ authorize: allow, tokenSecret: TEST_TOKEN_SECRET, storage });

    await write('draft one');
    const v1 = await driver.createVersion(DOC, 'u_author', 'before review');

    await write('draft two');
    await driver.restoreVersion(DOC, v1.id, 'u_restorer');

    const versions = await driver.listVersions(DOC);
    expect(versions).toHaveLength(2);

    const created = versions.find((version) => version.id !== v1.id)!;
    expect(created.createdBy).toBe('u_restorer');
    expect(created.label).toBe('restored from #1 (before review)');
    expect(created.seq).toBe(2);

    // And it holds what the restore threw away, not what it brought back.
    const snapshot = await storage.loadVersionSnapshot(DOC, created.id);
    const replaced = new Y.Doc();
    Y.applyUpdate(replaced, snapshot!);
    expect(replaced.getText('content').toString()).toBe('draft two');

    await driver.close();
  });

  it('falls back to the version id when the restored version has no label', async () => {
    const { storage, write } = await seed();
    const driver = new YjsDriver({ authorize: allow, tokenSecret: TEST_TOKEN_SECRET, storage });

    await write('draft one');
    const v1 = await driver.createVersion(DOC, 'u_author', null);
    await driver.restoreVersion(DOC, v1.id, null);

    const created = (await driver.listVersions(DOC)).find((version) => version.id !== v1.id)!;
    expect(created.label).toBe('restored from #1');
    expect(created.createdBy).toBeNull();

    await driver.close();
  });

  it('writes nothing when the version does not exist', async () => {
    const { storage, write } = await seed();
    const driver = new YjsDriver({ authorize: allow, tokenSecret: TEST_TOKEN_SECRET, storage });

    await write('draft one');
    await driver.createVersion(DOC, 'u_author', 'v1');

    await expect(driver.restoreVersion(DOC, 'no-such-version', 'u_restorer')).rejects.toThrow(
      /not found/,
    );
    expect(await driver.listVersions(DOC)).toHaveLength(1);

    await driver.close();
  });
});

describe('AutomergeDriver.restoreVersion', () => {
  it('records the replaced state as a new version, attributed to the restorer', async () => {
    const storage = new InMemoryCollaborationStorage();

    let doc = A.from<{ content: string }>({ content: 'draft one' });
    await storage.saveDocument(DOC, A.save(doc));

    const first = new AutomergeDriver({
      authorize: allow,
      tokenSecret: TEST_TOKEN_SECRET,
      storage,
    });
    const v1 = await first.createVersion(DOC, 'u_author', 'before review');
    await first.close();

    // Same lineage, later state — what the restore is about to replace.
    doc = A.change(doc, (draft) => {
      draft.content = 'draft two';
    });
    await storage.saveDocument(DOC, A.save(doc));

    const second = new AutomergeDriver({
      authorize: allow,
      tokenSecret: TEST_TOKEN_SECRET,
      storage,
    });
    await second.restoreVersion(DOC, v1.id, 'u_restorer');

    const versions = await second.listVersions(DOC);
    expect(versions).toHaveLength(2);

    const created = versions.find((version) => version.id !== v1.id)!;
    expect(created.createdBy).toBe('u_restorer');
    expect(created.label).toBe('restored from #1 (before review)');

    const snapshot = await storage.loadVersionSnapshot(DOC, created.id);
    expect(A.load<{ content: string }>(snapshot!).content.toString()).toBe('draft two');

    await second.close();
  });
});
