import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { YjsDriver } from '../src/drivers/yjs/yjs_driver.js';
import { onCollaborationError } from '../src/observability.js';
import { CommentService } from '../src/services/comment_service.js';
import {
  isBinaryEnvelope,
  isTextEnvelope,
  type StorageCodec,
  type StorageCodecContext,
  StorageCodecError,
  withCodec,
} from '../src/storage/codec.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';
import type { CollabComment } from '../src/types.js';
import { TEST_TOKEN_SECRET, testToken } from './helpers/token.js';

const allow = async () => ({ canRead: true, canWrite: true, canComment: true }) as const;
const DOC = 'researches/42/writing';

/** AES-256-GCM keyed per researcher (the id in the document name). */
function aesCodec(keys: Map<string, Buffer>, seen: StorageCodecContext[] = []): StorageCodec {
  const keyFor = (ctx: StorageCodecContext) => {
    const researcher = ctx.docName.split('/')[1]!;
    const key = keys.get(researcher);
    if (!key) throw new Error(`no key for researcher ${researcher}`);
    return key;
  };
  return {
    async encode(plaintext, ctx) {
      seen.push(ctx);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', keyFor(ctx), iv);
      cipher.setAAD(Buffer.from(`${ctx.docName}|${ctx.kind}|${ctx.field}`));
      const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
      const body = Buffer.concat([cipher.update(input), cipher.final()]);
      const out = Buffer.concat([iv, cipher.getAuthTag(), body]);
      // Text fields come back as base64 text, binary ones as bytes.
      return typeof plaintext === 'string' ? out.toString('base64') : new Uint8Array(out);
    },
    async decode(encoded, ctx) {
      seen.push(ctx);
      const raw =
        typeof encoded === 'string' ? Buffer.from(encoded, 'base64') : Buffer.from(encoded);
      const decipher = createDecipheriv('aes-256-gcm', keyFor(ctx), raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${ctx.docName}|${ctx.kind}|${ctx.field}`));
      decipher.setAuthTag(raw.subarray(12, 28));
      const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
      return ctx.field === 'body' || ctx.field === 'anchor'
        ? plain.toString('utf8')
        : new Uint8Array(plain);
    },
  };
}

function yState(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

function textOf(state: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getText('content').toString();
}

const comment = (overrides: Partial<CollabComment> = {}): CollabComment => ({
  id: 'c1',
  documentName: DOC,
  space: 'text',
  anchor: { kind: 'text-range', start: 0, end: 6, selectedText: 'secret' },
  body: 'confidential remark',
  userId: 'u1',
  authorName: null,
  resolvedAt: null,
  createdAt: new Date(2026, 0, 1).toISOString(),
  updatedAt: null,
  ...overrides,
});

describe('withCodec', () => {
  it('round-trips document state, and stores only ciphertext', async () => {
    const inner = new InMemoryCollaborationStorage();
    const seen: StorageCodecContext[] = [];
    const storage = withCodec(inner, aesCodec(new Map([['42', randomBytes(32)]]), seen));

    await storage.saveDocument(DOC, yState('private draft'));

    const raw = (await inner.loadDocument(DOC))!.state;
    expect(isBinaryEnvelope(raw)).toBe(true);
    expect(Buffer.from(raw).includes(Buffer.from('private draft'))).toBe(false);
    expect(textOf((await storage.loadDocument(DOC))!.state)).toBe('private draft');
    expect(seen[0]).toMatchObject({ docName: DOC, kind: 'document', field: 'state' });
  });

  it('reads legacy plaintext rows and encodes them on the next save', async () => {
    const inner = new InMemoryCollaborationStorage();
    await inner.saveDocument(DOC, yState('written before encryption'));
    const storage = withCodec(inner, aesCodec(new Map([['42', randomBytes(32)]])));

    const loaded = await storage.loadDocument(DOC);
    expect(textOf(loaded!.state)).toBe('written before encryption');
    expect(isBinaryEnvelope((await inner.loadDocument(DOC))!.state)).toBe(false);

    await storage.saveDocument(DOC, loaded!.state);
    expect(isBinaryEnvelope((await inner.loadDocument(DOC))!.state)).toBe(true);
    expect(textOf((await storage.loadDocument(DOC))!.state)).toBe('written before encryption');
  });

  it('decodes unmarked values the codec claims through isEncoded', async () => {
    const inner = new InMemoryCollaborationStorage();
    const codec: StorageCodec = {
      encode: async (value) => value,
      decode: async (value) => (value as Uint8Array).subarray(1),
      isEncoded: (value) => (value as Uint8Array)[0] === 0xee,
    };
    const state = yState('app-encoded');
    await inner.saveDocument(DOC, Uint8Array.of(0xee, ...state));

    const loaded = await withCodec(inner, codec).loadDocument(DOC);
    expect(textOf(loaded!.state)).toBe('app-encoded');
  });

  it('surfaces a decode failure and refuses to overwrite the stored state', async () => {
    const inner = new InMemoryCollaborationStorage();
    await withCodec(inner, aesCodec(new Map([['42', randomBytes(32)]]))).saveDocument(
      DOC,
      yState('the real content'),
    );
    const before = (await inner.loadDocument(DOC))!.state;

    // Same storage, wrong key: the stored state cannot be decrypted.
    const storage = withCodec(inner, aesCodec(new Map([['42', randomBytes(32)]])));
    const failure = await storage.loadDocument(DOC).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StorageCodecError);
    expect((failure as StorageCodecError).code).toBe('decode-failed');

    const refused = await storage.saveDocument(DOC, yState('')).catch((error: unknown) => error);
    expect((refused as StorageCodecError).code).toBe('previous-state-unreadable');
    expect((await inner.loadDocument(DOC))!.state).toEqual(before);

    // Overwriting on purpose stays possible.
    storage.forgetDecodeFailure(DOC);
    await storage.saveDocument(DOC, yState('replacement'));
    expect(textOf((await storage.loadDocument(DOC))!.state)).toBe('replacement');
  });

  it('never returns an empty document for a non-empty stored state', async () => {
    const inner = new InMemoryCollaborationStorage();
    const storage = withCodec(inner, {
      encode: async (value) => value,
      decode: async () => new Uint8Array(),
    });
    await storage.saveDocument(DOC, yState('content'));
    const failure = await storage.loadDocument(DOC).catch((error: unknown) => error);
    expect((failure as StorageCodecError).code).toBe('invalid-output');
    await expect(storage.saveDocument(DOC, yState(''))).rejects.toMatchObject({
      code: 'previous-state-unreadable',
    });
  });

  it('wraps an encode failure and writes nothing', async () => {
    const inner = new InMemoryCollaborationStorage();
    const storage = withCodec(inner, {
      encode: async () => {
        throw new Error('kms down');
      },
      decode: async (value) => value,
    });
    await expect(storage.saveDocument(DOC, yState('x'))).rejects.toMatchObject({
      code: 'encode-failed',
    });
    expect(await inner.loadDocument(DOC)).toBeNull();
  });

  it('round-trips version snapshots, and reads legacy ones', async () => {
    const inner = new InMemoryCollaborationStorage();
    const storage = withCodec(inner, aesCodec(new Map([['42', randomBytes(32)]])));
    const version = {
      id: 'v1',
      seq: 1,
      createdAt: new Date().toISOString(),
      createdBy: null,
      label: null,
    };
    await storage.saveVersion(DOC, version, yState('at v1'));
    await inner.saveVersion(DOC, { ...version, id: 'v0', seq: 0 }, yState('legacy v0'));

    expect(isBinaryEnvelope((await inner.loadVersionSnapshot(DOC, 'v1'))!)).toBe(true);
    expect(textOf((await storage.loadVersionSnapshot(DOC, 'v1'))!)).toBe('at v1');
    expect(textOf((await storage.loadVersionSnapshot(DOC, 'v0'))!)).toBe('legacy v0');
    expect(await storage.listVersions(DOC)).toHaveLength(2);
  });

  it('encodes comment bodies and anchors, through the comment service', async () => {
    const inner = new InMemoryCollaborationStorage();
    const storage = withCodec(inner, aesCodec(new Map([['42', randomBytes(32)]])));
    const comments = new CommentService(storage);

    const created = await comments.create(DOC, {
      space: 'text',
      anchor: { kind: 'text-range', start: 0, end: 6, selectedText: 'secret' },
      body: 'confidential remark',
      userId: 'u1',
    });

    const [raw] = await inner.listComments(DOC);
    expect(isTextEnvelope(raw!.body)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain('confidential');
    expect(JSON.stringify(raw)).not.toContain('secret');

    const [listed] = await comments.list(DOC);
    expect(listed!.body).toBe('confidential remark');
    expect(listed!.anchor).toEqual({
      kind: 'text-range',
      start: 0,
      end: 6,
      selectedText: 'secret',
    });
    expect((await comments.get(DOC, created.id))!.body).toBe('confidential remark');
  });

  it('reads legacy plaintext comments', async () => {
    const inner = new InMemoryCollaborationStorage();
    await inner.saveComment(DOC, comment());
    const storage = withCodec(inner, aesCodec(new Map([['42', randomBytes(32)]])));
    const [listed] = await storage.listComments(DOC);
    expect(listed).toMatchObject({
      body: 'confidential remark',
      anchor: { selectedText: 'secret' },
    });
  });

  it('keeps optional methods optional', () => {
    const inner = new InMemoryCollaborationStorage();
    const storage = withCodec(inner, aesCodec(new Map()));
    expect(typeof storage.countVersions).toBe('function');
    const bare = withCodec(
      {
        ...inner,
        loadDocument: inner.loadDocument.bind(inner),
        countVersions: undefined,
      } as unknown as InMemoryCollaborationStorage,
      aesCodec(new Map()),
    );
    expect(bare.countVersions).toBeUndefined();
  });
});

describe('YjsDriver with a codec', () => {
  const teardown: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of teardown.splice(0).reverse()) await fn();
  });

  async function serve(driver: YjsDriver): Promise<number> {
    const server = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    teardown.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await driver.attach(server);
    return (server.address() as AddressInfo).port;
  }

  it('serves the decrypted document and persists edits encrypted', async () => {
    const inner = new InMemoryCollaborationStorage();
    const storage = withCodec(inner, aesCodec(new Map([['42', randomBytes(32)]])));
    await storage.saveDocument(DOC, yState('hello'));
    const driver = new YjsDriver({
      authorize: allow,
      tokenSecret: TEST_TOKEN_SECRET,
      storage,
      path: '/collab',
      debounce: 10,
    });
    teardown.push(() => driver.close());
    const port = await serve(driver);

    const doc = new Y.Doc();
    const provider = await new Promise<HocuspocusProvider>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('never synced')), 4000);
      const p = new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}/collab`,
        name: DOC,
        document: doc,
        token: testToken(DOC),
        onSynced: ({ state }) => {
          if (!state) return;
          clearTimeout(timer);
          resolve(p);
        },
      });
    });
    teardown.push(() => provider.destroy());
    expect(doc.getText('content').toString()).toBe('hello');

    doc.getText('content').insert(5, ' world');
    await expect
      .poll(async () => textOf((await storage.loadDocument(DOC))!.state), { timeout: 3000 })
      .toBe('hello world');
    expect(isBinaryEnvelope((await inner.loadDocument(DOC))!.state)).toBe(true);
    // Server-side reads still see plaintext.
    expect(textOf(await driver.getDocumentState(DOC))).toBe('hello world');
  });

  it('fails the load, reports it, and never stores over an undecodable document', async () => {
    const inner = new InMemoryCollaborationStorage();
    await withCodec(inner, aesCodec(new Map([['42', randomBytes(32)]]))).saveDocument(
      DOC,
      yState('the real content'),
    );
    const before = (await inner.loadDocument(DOC))!.state;
    const storage = withCodec(inner, aesCodec(new Map([['42', randomBytes(32)]])));

    const reported: string[] = [];
    teardown.push(onCollaborationError((event) => reported.push(event.operation)));

    const driver = new YjsDriver({
      authorize: allow,
      tokenSecret: TEST_TOKEN_SECRET,
      storage,
      path: '/collab',
      debounce: 10,
    });
    teardown.push(() => driver.close());
    const port = await serve(driver);

    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}/collab`,
      name: DOC,
      document: doc,
      token: testToken(DOC),
    });
    teardown.push(() => provider.destroy());
    // The client types into its (empty) local copy while the server refuses the load.
    doc.getText('content').insert(0, 'overwrite attempt');

    await expect.poll(() => reported, { timeout: 3000 }).toContain('loadDocument');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await inner.loadDocument(DOC))!.state).toEqual(before);

    // Server-side paths that write fail the same way instead of writing.
    await expect(driver.createVersion(DOC, 'u1', 'checkpoint')).rejects.toBeInstanceOf(
      StorageCodecError,
    );
    await expect(storage.saveDocument(DOC, yState(''))).rejects.toMatchObject({
      code: 'previous-state-unreadable',
    });
    expect((await inner.loadDocument(DOC))!.state).toEqual(before);
  });
});
