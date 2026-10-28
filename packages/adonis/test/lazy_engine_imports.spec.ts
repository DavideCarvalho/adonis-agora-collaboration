import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { TEST_TOKEN_SECRET } from './helpers/token.js';

/**
 * The root entry re-exports every driver, so whatever a driver imports at its
 * top is paid by every process that imports the package — ace commands, queue
 * workers, web pods that never open a document. Automerge (WASM),
 * `@hocuspocus/server` and `@hocuspocus/transformer` (Tiptap + ProseMirror)
 * are loaded on first use instead. Each spy records the moment its module is
 * evaluated, whoever imports it.
 */
const loaded = vi.hoisted(() => new Set<string>());
vi.mock('@automerge/automerge', async (importOriginal) => {
  loaded.add('automerge');
  return importOriginal();
});
vi.mock('@hocuspocus/server', async (importOriginal) => {
  loaded.add('hocuspocus-server');
  return importOriginal();
});
vi.mock('@hocuspocus/transformer', async (importOriginal) => {
  loaded.add('hocuspocus-transformer');
  return importOriginal();
});

const allow = async () => ({ canRead: true, canWrite: true, canComment: true }) as const;

function tiptapDoc(text: string): Uint8Array {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment('default').insert(0, [paragraph]);
  return Y.encodeStateAsUpdate(doc);
}

describe('engine dependencies load on first use', () => {
  it('importing the package and its provider loads none of them', async () => {
    await import('../src/index.js');
    await import('../providers/collaboration_provider.js');
    expect([...loaded]).toEqual([]);
  });

  it('a yjs driver loads the transformer to read text, and Hocuspocus only to attach', async () => {
    const { YjsDriver } = await import('../src/drivers/yjs/yjs_driver.js');
    const { InMemoryCollaborationStorage } = await import('../src/storage/in_memory_storage.js');
    const storage = new InMemoryCollaborationStorage();
    await storage.saveDocument('docs/1', tiptapDoc('hello'));
    const driver = new YjsDriver({ authorize: allow, tokenSecret: TEST_TOKEN_SECRET, storage });

    expect(await driver.getDocumentText('docs/1')).toBe('hello');
    expect(loaded.has('hocuspocus-transformer')).toBe(true);
    expect(loaded.has('hocuspocus-server')).toBe(false);
    expect(driver.liveDocument('docs/1')).toBeUndefined();

    const server = createServer();
    await driver.attach(server);
    expect(loaded.has('hocuspocus-server')).toBe(true);
    await driver.close();
    expect(loaded.has('automerge')).toBe(false);
  });

  it('an automerge driver loads Automerge when it opens a document', async () => {
    const { AutomergeDriver } = await import('../src/drivers/automerge/automerge_driver.js');
    const driver = new AutomergeDriver({ authorize: allow, tokenSecret: TEST_TOKEN_SECRET });
    expect(loaded.has('automerge')).toBe(false);
    expect(await driver.getDocumentText('docs/2')).toBe('');
    expect(loaded.has('automerge')).toBe(true);
    await driver.close();
  });
});
