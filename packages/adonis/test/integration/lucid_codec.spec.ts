import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  isBinaryEnvelope,
  isEncodedAnchor,
  isTextEnvelope,
  type StorageCodec,
} from '../../src/storage/codec.js';
import type { LucidConnectionLike, LucidStorage } from '../../src/storage/lucid_storage.js';
import type { CollabComment } from '../../src/types.js';
import { createIntegrationDatabase, type IntegrationDatabase } from './harness.js';

/**
 * `lucidStorage({ codec })` against a real Postgres, with the published
 * migrations: ciphertext fits the existing columns (bytea, text, jsonb), legacy
 * plaintext rows keep loading, and `reencodeAll` migrates them in batches.
 */
const SCHEMA = 'collab_codec';
const DOC = 'researches/7/writing';

function aes(key: Buffer): StorageCodec {
  return {
    async encode(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const input = typeof plaintext === 'string' ? Buffer.from(plaintext) : plaintext;
      const body = Buffer.concat([cipher.update(input), cipher.final()]);
      return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body]));
    },
    async decode(encoded, ctx) {
      const raw = Buffer.from(encoded as Uint8Array);
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
      return ctx.kind === 'comment' ? plain.toString('utf8') : new Uint8Array(plain);
    },
  };
}

const yState = (text: string) => {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
};
const textOf = (state: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getText('content').toString();
};

const comment = (id: string): CollabComment => ({
  id,
  documentName: DOC,
  space: 'text',
  anchor: { kind: 'text-range', start: 0, end: 5, selectedText: 'quote' },
  body: `note ${id}`,
  userId: 'u1',
  authorName: null,
  resolvedAt: null,
  createdAt: new Date(2026, 0, 1).toISOString(),
  updatedAt: null,
});

describe('LucidStorage with a codec (Postgres)', () => {
  let integration: IntegrationDatabase;
  let Storage: typeof LucidStorage;
  const key = randomBytes(32);
  const make = (codec?: StorageCodec) =>
    new Storage(integration.db as unknown as LucidConnectionLike, codec ? { codec } : {});

  beforeAll(async () => {
    integration = await createIntegrationDatabase(SCHEMA);
    ({ LucidStorage: Storage } = await import('../../src/storage/lucid_storage.js'));
  });

  afterAll(async () => {
    await integration?.teardown();
  });

  beforeEach(async () => {
    await integration.db.rawQuery(
      `TRUNCATE "${SCHEMA}".collab_versions, "${SCHEMA}".collab_documents, "${SCHEMA}".collab_comments`,
    );
  });

  const raw = async (sql: string) => (await integration.db.rawQuery(sql)).rows as any[];

  it('stores ciphertext in the existing columns and reads it back', async () => {
    const storage = make(aes(key));
    await storage.saveDocument(DOC, yState('secret manuscript'), { owner: 7 });
    await storage.saveVersion(
      DOC,
      { id: 'v1', seq: 1, createdAt: new Date().toISOString(), createdBy: null, label: null },
      yState('secret v1'),
    );
    await storage.saveComment(DOC, comment('c1'));

    const [doc] = await raw(`SELECT state, meta FROM "${SCHEMA}".collab_documents`);
    expect(isBinaryEnvelope(doc.state)).toBe(true);
    expect((doc.state as Buffer).includes(Buffer.from('secret'))).toBe(false);
    const [version] = await raw(`SELECT snapshot FROM "${SCHEMA}".collab_versions`);
    expect(isBinaryEnvelope(version.snapshot)).toBe(true);
    const [row] = await raw(`SELECT body, anchor FROM "${SCHEMA}".collab_comments`);
    expect(isTextEnvelope(row.body)).toBe(true);
    expect(isEncodedAnchor(row.anchor)).toBe(true);
    expect(JSON.stringify(row)).not.toContain('quote');

    const loaded = await storage.loadDocument(DOC);
    expect(textOf(loaded!.state)).toBe('secret manuscript');
    expect(loaded!.meta).toEqual({ owner: 7 });
    expect(textOf((await storage.loadVersionSnapshot(DOC, 'v1'))!)).toBe('secret v1');
    expect(await storage.getComment(DOC, 'c1')).toMatchObject({
      body: 'note c1',
      anchor: { selectedText: 'quote' },
    });
  });

  it('refuses to save over a row it could not decode', async () => {
    await make(aes(key)).saveDocument(DOC, yState('real'));
    const wrong = make(aes(randomBytes(32)));
    await expect(wrong.loadDocument(DOC)).rejects.toMatchObject({ code: 'decode-failed' });
    await expect(wrong.saveDocument(DOC, yState(''))).rejects.toMatchObject({
      code: 'previous-state-unreadable',
    });
    expect(textOf((await make(aes(key)).loadDocument(DOC))!.state)).toBe('real');
  });

  it('loads legacy plaintext rows and re-encodes them in batches', async () => {
    const plain = make();
    for (let index = 0; index < 5; index++) {
      await plain.saveDocument(`researches/7/doc-${index}`, yState(`legacy ${index}`));
      await plain.saveComment(`researches/7/doc-${index}`, {
        ...comment(`c${index}`),
        documentName: `researches/7/doc-${index}`,
      });
    }
    await plain.saveVersion(
      DOC,
      { id: 'v1', seq: 1, createdAt: new Date().toISOString(), createdBy: null, label: null },
      yState('legacy v1'),
    );

    const storage = make(aes(key));
    expect(textOf((await storage.loadDocument('researches/7/doc-3'))!.state)).toBe('legacy 3');
    expect((await storage.listComments('researches/7/doc-3'))[0]!.body).toBe('note c3');

    // An already-encoded row next to the legacy ones is skipped.
    await storage.saveDocument('researches/7/doc-0', yState('legacy 0'));

    const dry = await storage.reencodeAll({ batchSize: 2, dryRun: true });
    expect(dry).toEqual({ documents: 4, versions: 1, comments: 5 });

    const progress: number[] = [];
    const result = await storage.reencodeAll({
      batchSize: 2,
      onProgress: (p) => progress.push(p.documents + p.versions + p.comments),
    });
    expect(result).toEqual({ documents: 4, versions: 1, comments: 5 });
    expect(progress.length).toBeGreaterThan(3);

    const docs = await raw(`SELECT state FROM "${SCHEMA}".collab_documents`);
    expect(docs.every((row) => isBinaryEnvelope(row.state))).toBe(true);
    const comments = await raw(`SELECT body, anchor FROM "${SCHEMA}".collab_comments`);
    expect(comments.every((row) => isTextEnvelope(row.body) && isEncodedAnchor(row.anchor))).toBe(
      true,
    );
    expect(textOf((await storage.loadDocument('researches/7/doc-4'))!.state)).toBe('legacy 4');
    expect(textOf((await storage.loadVersionSnapshot(DOC, 'v1'))!)).toBe('legacy v1');

    // Idempotent: a second run has nothing left to do.
    expect(await storage.reencodeAll()).toEqual({ documents: 0, versions: 0, comments: 0 });
  });
});
