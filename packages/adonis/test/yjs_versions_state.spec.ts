import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { YjsDriver } from '../src/drivers/yjs/yjs_driver.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';
import { TEST_TOKEN_SECRET } from './helpers/token.js';

const allow = async () => ({ canRead: true, canWrite: true, canComment: true }) as const;
const DOC = 'researches/42/writing';

/** A Tiptap-shaped document: paragraphs in the `default` fragment. */
function setParagraphs(doc: Y.Doc, texts: string[]) {
  const fragment = doc.getXmlFragment('default');
  doc.transact(() => {
    fragment.delete(0, fragment.length);
    fragment.insert(
      0,
      texts.map((text) => {
        const paragraph = new Y.XmlElement('paragraph');
        paragraph.insert(0, [new Y.XmlText(text)]);
        return paragraph;
      }),
    );
  });
}

function textOf(state: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc
    .getXmlFragment('default')
    .toArray()
    .map((node) => (node as Y.XmlElement).toArray().map(String).join(''))
    .join('|');
}

describe('YjsDriver.restoreVersion — content', () => {
  it('brings back content deleted since the version, in the same document', async () => {
    const storage = new InMemoryCollaborationStorage();
    const driver = new YjsDriver({ authorize: allow, tokenSecret: TEST_TOKEN_SECRET, storage });

    // One lineage, as in real use: the version's items are later deleted.
    const doc = new Y.Doc();
    setParagraphs(doc, ['draft one']);
    await storage.saveDocument(DOC, Y.encodeStateAsUpdate(doc));
    const v1 = await driver.createVersion(DOC, 'u_author', 'v1');

    setParagraphs(doc, ['draft two']);
    await storage.saveDocument(DOC, Y.encodeStateAsUpdate(doc));

    await driver.restoreVersion(DOC, v1.id, 'u_restorer');

    const stored = await storage.loadDocument(DOC);
    expect(textOf(stored!.state)).toBe('draft one');
    await driver.close();
  });

  it('does not duplicate a version from another lineage', async () => {
    const storage = new InMemoryCollaborationStorage();
    const driver = new YjsDriver({ authorize: allow, tokenSecret: TEST_TOKEN_SECRET, storage });

    const first = new Y.Doc();
    setParagraphs(first, ['old seed']);
    await storage.saveDocument(DOC, Y.encodeStateAsUpdate(first));
    const v1 = await driver.createVersion(DOC, null, null);

    const replaced = new Y.Doc();
    setParagraphs(replaced, ['new seed']);
    await storage.saveDocument(DOC, Y.encodeStateAsUpdate(replaced));

    await driver.restoreVersion(DOC, v1.id, null);
    expect(textOf((await storage.loadDocument(DOC))!.state)).toBe('old seed');
    await driver.close();
  });
});

describe('YjsDriver.compactDocument', () => {
  it('drops deleted history, keeps the content and a "before compaction" version', async () => {
    const storage = new InMemoryCollaborationStorage();
    const driver = new YjsDriver({ authorize: allow, tokenSecret: TEST_TOKEN_SECRET, storage });

    const doc = new Y.Doc();
    for (let round = 0; round < 30; round++) {
      setParagraphs(doc, [`round ${round} `.repeat(50), 'second paragraph']);
    }
    const bloated = Y.encodeStateAsUpdate(doc);
    await storage.saveDocument(DOC, bloated);

    const result = await driver.compactDocument(DOC);

    expect(result.before).toBe(bloated.byteLength);
    expect(result.after).toBeLessThan(result.before);
    const stored = (await storage.loadDocument(DOC))!.state;
    expect(textOf(stored)).toBe(textOf(bloated));

    const versions = await driver.listVersions(DOC);
    expect(versions.map((version) => version.label)).toEqual(['before compaction']);
    const backup = await storage.loadVersionSnapshot(DOC, versions[0]!.id);
    expect(backup!.byteLength).toBe(bloated.byteLength);
    await driver.close();
  });

  it('dry run writes nothing', async () => {
    const storage = new InMemoryCollaborationStorage();
    const driver = new YjsDriver({ authorize: allow, tokenSecret: TEST_TOKEN_SECRET, storage });
    const doc = new Y.Doc();
    for (let round = 0; round < 10; round++) setParagraphs(doc, [`round ${round}`]);
    const bloated = Y.encodeStateAsUpdate(doc);
    await storage.saveDocument(DOC, bloated);

    const result = await driver.compactDocument(DOC, { dryRun: true });

    expect(result.after).toBeLessThan(result.before);
    expect((await storage.loadDocument(DOC))!.state.byteLength).toBe(bloated.byteLength);
    expect(await driver.listVersions(DOC)).toHaveLength(0);
    await driver.close();
  });

  it('refuses a document with content outside the default fragment', async () => {
    const storage = new InMemoryCollaborationStorage();
    const driver = new YjsDriver({ authorize: allow, tokenSecret: TEST_TOKEN_SECRET, storage });
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'plain text');
    await storage.saveDocument(DOC, Y.encodeStateAsUpdate(doc));

    await expect(driver.compactDocument(DOC)).rejects.toThrow(/outside the 'default' fragment/);
    await driver.close();
  });
});

describe('YjsDriver — unchanged documents are not written back', () => {
  type Hook = (payload: { documentName: string; document: Y.Doc }) => Promise<unknown>;
  function hooksOf(driver: YjsDriver) {
    const { hocuspocus } = driver as unknown as {
      hocuspocus: {
        configuration: {
          afterLoadDocument: Hook;
          onStoreDocument: Hook;
          beforeUnloadDocument: Hook;
        };
      };
    };
    return hocuspocus.configuration;
  }

  it('skips the save when the document closes as it was loaded, saves after a change', async () => {
    const storage = new InMemoryCollaborationStorage();
    let saves = 0;
    const save = storage.saveDocument.bind(storage);
    storage.saveDocument = async (...args) => {
      saves++;
      return save(...args);
    };
    const driver = new YjsDriver({ authorize: allow, tokenSecret: TEST_TOKEN_SECRET, storage });
    const hooks = hooksOf(driver);

    // A server-side reader opens the document and lets it go.
    const document = new Y.Doc();
    setParagraphs(document, ['stored']);
    await hooks.afterLoadDocument({ documentName: DOC, document });
    await hooks.beforeUnloadDocument({ documentName: DOC, document });
    await hooks.onStoreDocument({ documentName: DOC, document });
    expect(saves).toBe(0);

    setParagraphs(document, ['edited']);
    await hooks.onStoreDocument({ documentName: DOC, document });
    await hooks.beforeUnloadDocument({ documentName: DOC, document });
    expect(saves).toBe(1);
    expect(textOf((await storage.loadDocument(DOC))!.state)).toBe('edited');
    await driver.close();
  });
});
