import type {
  CollabComment,
  CollaborationStorage,
  CollabVersion,
  CommentAnchor,
  ListPageOptions,
  PruneVersionsOptions,
} from '../types.js';

/** What a codec reads and writes: raw bytes, or a string (e.g. a ciphertext token). */
export type StorageCodecValue = Uint8Array | string;

/** Which kind of row a value belongs to. */
export type StorageCodecKind = 'document' | 'version' | 'comment';

/** Which column of that row. */
export type StorageCodecField = 'state' | 'snapshot' | 'body' | 'anchor';

/**
 * Everything a codec gets to pick a key with. `docName` is always set and is
 * the same on encode and decode, so it is the safe thing to derive a key from.
 */
export interface StorageCodecContext {
  /** The document the value belongs to (for a comment: its document). */
  docName: string;
  kind: StorageCodecKind;
  field: StorageCodecField;
  /** Set for `kind: 'version'`. */
  versionId?: string;
  /** Set for `kind: 'comment'`. */
  commentId?: string;
  /**
   * The document's `meta`, when the storage has it at hand (Lucid: on load,
   * and on save when the caller passed one). Not guaranteed to be the same on
   * encode and decode — do not make the key depend on it alone.
   */
  meta?: Record<string, unknown> | null;
}

/**
 * Transforms what the storage persists — typically encryption at rest. The
 * server keeps working on plaintext in memory; only stored bytes go through
 * the codec.
 *
 * - `encode` receives a `Uint8Array` for document state and version snapshots,
 *   and a `string` for comment bodies and anchors (the anchor as JSON). It may
 *   return either type.
 * - `decode` receives exactly what `encode` returned (same type) and must
 *   return the original plaintext (`Uint8Array` for state/snapshot, `string`
 *   for body/anchor). Throw when it cannot: the error reaches the caller, and
 *   the storage refuses to overwrite a document whose stored state it could
 *   not decode.
 */
export interface StorageCodec {
  encode(plaintext: StorageCodecValue, ctx: StorageCodecContext): Promise<StorageCodecValue>;
  decode(encoded: StorageCodecValue, ctx: StorageCodecContext): Promise<StorageCodecValue>;
  /**
   * Only for values the library did not mark as encoded (rows written before
   * the codec was configured). Return `true` for values your app already
   * encoded by itself, so they are decoded instead of read as plaintext.
   * Without it, every unmarked value is plaintext.
   */
  isEncoded?(stored: StorageCodecValue, ctx: StorageCodecContext): boolean | Promise<boolean>;
}

export type StorageCodecErrorCode =
  /** `codec.decode` threw, or a stored envelope is malformed. */
  | 'decode-failed'
  /** `codec.encode` threw. */
  | 'encode-failed'
  /** The codec returned the wrong type or an empty document. */
  | 'invalid-output'
  /** A save was refused because the stored state could not be decoded. */
  | 'previous-state-unreadable';

/** A value could not be encoded or decoded, or a write was refused to protect stored data. */
export class StorageCodecError extends Error {
  readonly code: StorageCodecErrorCode;
  readonly docName: string;
  readonly kind: StorageCodecKind;

  constructor(
    code: StorageCodecErrorCode,
    ctx: Pick<StorageCodecContext, 'docName' | 'kind'>,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[@adonis-agora/collaboration] ${message}`, options);
    this.name = 'StorageCodecError';
    this.code = code;
    this.docName = ctx.docName;
    this.kind = ctx.kind;
  }
}

/*
 * Envelope format. Binary columns: MAGIC, a type byte, then the codec output
 * (bytes as is, a string as UTF-8). MAGIC starts with 0xff 0x00, which no
 * Yjs update (canonical lib0 varuint: 0xff is never followed by 0x00), Yjs v2
 * update (starts with 0x00) or Automerge document (starts with 0x85) begins
 * with, so legacy plaintext is never mistaken for an envelope. Text columns:
 * TEXT_PREFIX, a type letter and `:`, then base64 bytes or the string.
 */
const MAGIC = Uint8Array.of(0xff, 0x00, 0x61, 0x67, 0x63, 0x31); // ff 00 "agc1"
const TYPE_BYTES = 0x62; // 'b'
const TYPE_STRING = 0x73; // 's'
const TEXT_PREFIX = 'agora-codec:1:';
/** Key of the JSON object an encoded anchor is stored as. */
export const ENCODED_ANCHOR_KEY = '$agoraCodec';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** True when `stored` carries the library's binary envelope. */
export function isBinaryEnvelope(stored: Uint8Array): boolean {
  if (stored.byteLength < MAGIC.byteLength + 1) return false;
  for (let index = 0; index < MAGIC.byteLength; index++) {
    if (stored[index] !== MAGIC[index]) return false;
  }
  return true;
}

/** True when `stored` carries the library's text envelope. */
export function isTextEnvelope(stored: string): boolean {
  return typeof stored === 'string' && stored.startsWith(TEXT_PREFIX);
}

/** True when a stored anchor is an encoded one. */
export function isEncodedAnchor(stored: unknown): boolean {
  const value = typeof stored === 'string' ? safeJson(stored) : stored;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)[ENCODED_ANCHOR_KEY] === 'string'
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describe(ctx: StorageCodecContext): string {
  const id = ctx.versionId ?? ctx.commentId;
  return `${ctx.kind} ${ctx.field} of "${ctx.docName}"${id ? ` (${id})` : ''}`;
}

/**
 * Applies a {@link StorageCodec} to stored values and keeps the
 * do-not-overwrite guard. Shared by `withCodec` and `LucidStorage`.
 */
export class StorageCodecRunner {
  /** Documents whose stored state failed to decode in this process. */
  private readonly unreadable = new Set<string>();

  constructor(readonly codec: StorageCodec) {
    if (!codec || typeof codec.encode !== 'function' || typeof codec.decode !== 'function') {
      throw new TypeError(
        '[@adonis-agora/collaboration] a storage codec needs async encode() and decode() functions',
      );
    }
  }

  private async encodeValue(
    plaintext: StorageCodecValue,
    ctx: StorageCodecContext,
  ): Promise<StorageCodecValue> {
    let encoded: StorageCodecValue;
    try {
      encoded = await this.codec.encode(plaintext, ctx);
    } catch (error) {
      throw new StorageCodecError('encode-failed', ctx, `could not encode the ${describe(ctx)}`, {
        cause: error,
      });
    }
    if (!(encoded instanceof Uint8Array) && typeof encoded !== 'string') {
      throw new StorageCodecError(
        'invalid-output',
        ctx,
        `codec.encode returned ${typeof encoded} for the ${describe(ctx)}; expected a Uint8Array or a string`,
      );
    }
    return encoded;
  }

  private async decodeValue(
    encoded: StorageCodecValue,
    ctx: StorageCodecContext,
    expect: 'bytes' | 'string',
  ): Promise<StorageCodecValue> {
    let decoded: StorageCodecValue;
    try {
      decoded = await this.codec.decode(encoded, ctx);
    } catch (error) {
      throw new StorageCodecError('decode-failed', ctx, `could not decode the ${describe(ctx)}`, {
        cause: error,
      });
    }
    if (expect === 'string') {
      if (typeof decoded === 'string') return decoded;
      if (decoded instanceof Uint8Array) {
        try {
          return utf8Decoder.decode(decoded);
        } catch (error) {
          throw new StorageCodecError(
            'invalid-output',
            ctx,
            `codec.decode returned bytes that are not UTF-8 for the ${describe(ctx)}`,
            { cause: error },
          );
        }
      }
    } else if (decoded instanceof Uint8Array) {
      return decoded;
    }
    throw new StorageCodecError(
      'invalid-output',
      ctx,
      `codec.decode returned ${typeof decoded} for the ${describe(ctx)}; expected ${expect === 'bytes' ? 'a Uint8Array' : 'a string'}`,
    );
  }

  private async legacyIsEncoded(
    stored: StorageCodecValue,
    ctx: StorageCodecContext,
  ): Promise<boolean> {
    if (!this.codec.isEncoded) return false;
    try {
      return await this.codec.isEncoded(stored, ctx);
    } catch (error) {
      throw new StorageCodecError(
        'decode-failed',
        ctx,
        `codec.isEncoded threw for the ${describe(ctx)}`,
        {
          cause: error,
        },
      );
    }
  }

  /** Plaintext bytes (state, snapshot) → bytes to store in a binary column. */
  async encodeBinary(plaintext: Uint8Array, ctx: StorageCodecContext): Promise<Uint8Array> {
    const encoded = await this.encodeValue(plaintext, ctx);
    const payload = typeof encoded === 'string' ? utf8Encoder.encode(encoded) : encoded;
    const out = new Uint8Array(MAGIC.byteLength + 1 + payload.byteLength);
    out.set(MAGIC, 0);
    out[MAGIC.byteLength] = typeof encoded === 'string' ? TYPE_STRING : TYPE_BYTES;
    out.set(payload, MAGIC.byteLength + 1);
    return out;
  }

  /**
   * Stored bytes → plaintext bytes. Unmarked bytes are legacy plaintext (or,
   * with `isEncoded`, the app's own encoding). A decoded document or snapshot
   * is never empty: an empty one would read as "nothing stored" and be
   * overwritten.
   */
  async decodeBinary(stored: Uint8Array, ctx: StorageCodecContext): Promise<Uint8Array> {
    let decoded: Uint8Array;
    if (isBinaryEnvelope(stored)) {
      const type = stored[MAGIC.byteLength];
      const payload = stored.subarray(MAGIC.byteLength + 1);
      let encoded: StorageCodecValue;
      if (type === TYPE_BYTES) encoded = payload;
      else if (type === TYPE_STRING) {
        try {
          encoded = utf8Decoder.decode(payload);
        } catch (error) {
          throw new StorageCodecError(
            'decode-failed',
            ctx,
            `malformed envelope in the ${describe(ctx)}`,
            {
              cause: error,
            },
          );
        }
      } else {
        throw new StorageCodecError(
          'decode-failed',
          ctx,
          `unknown envelope type 0x${(type ?? 0).toString(16)} in the ${describe(ctx)}`,
        );
      }
      decoded = (await this.decodeValue(encoded, ctx, 'bytes')) as Uint8Array;
    } else if (await this.legacyIsEncoded(stored, ctx)) {
      decoded = (await this.decodeValue(stored, ctx, 'bytes')) as Uint8Array;
    } else {
      return stored;
    }
    if (decoded.byteLength === 0 && stored.byteLength > 0) {
      throw new StorageCodecError(
        'invalid-output',
        ctx,
        `codec.decode returned no bytes for the ${describe(ctx)}; refusing to treat it as empty`,
      );
    }
    return decoded;
  }

  /** Plaintext string (comment body, anchor JSON) → string to store in a text column. */
  async encodeText(plaintext: string, ctx: StorageCodecContext): Promise<string> {
    const encoded = await this.encodeValue(plaintext, ctx);
    return typeof encoded === 'string'
      ? `${TEXT_PREFIX}s:${encoded}`
      : `${TEXT_PREFIX}b:${Buffer.from(encoded).toString('base64')}`;
  }

  /** Stored string → plaintext string. Unmarked strings are legacy plaintext. */
  async decodeText(stored: string, ctx: StorageCodecContext): Promise<string> {
    if (isTextEnvelope(stored)) {
      const rest = stored.slice(TEXT_PREFIX.length);
      let encoded: StorageCodecValue;
      if (rest.startsWith('s:')) encoded = rest.slice(2);
      else if (rest.startsWith('b:'))
        encoded = new Uint8Array(Buffer.from(rest.slice(2), 'base64'));
      else {
        throw new StorageCodecError(
          'decode-failed',
          ctx,
          `malformed envelope in the ${describe(ctx)}`,
        );
      }
      return (await this.decodeValue(encoded, ctx, 'string')) as string;
    }
    if (await this.legacyIsEncoded(stored, ctx)) {
      return (await this.decodeValue(stored, ctx, 'string')) as string;
    }
    return stored;
  }

  /** A comment anchor → the JSON object stored in its place. */
  async encodeAnchor(
    anchor: CommentAnchor,
    ctx: StorageCodecContext,
  ): Promise<{ [ENCODED_ANCHOR_KEY]: string }> {
    return { [ENCODED_ANCHOR_KEY]: await this.encodeText(JSON.stringify(anchor), ctx) };
  }

  /** A stored anchor (encoded or legacy plaintext; object or JSON string) → the anchor. */
  async decodeAnchor(stored: unknown, ctx: StorageCodecContext): Promise<CommentAnchor> {
    const value = typeof stored === 'string' ? safeJson(stored) : stored;
    if (!isEncodedAnchor(value)) return (value ?? stored) as CommentAnchor;
    const json = await this.decodeText(
      (value as Record<string, string>)[ENCODED_ANCHOR_KEY] as string,
      ctx,
    );
    const anchor = safeJson(json);
    if (typeof anchor !== 'object' || anchor === null) {
      throw new StorageCodecError(
        'invalid-output',
        ctx,
        `codec.decode did not return anchor JSON for the ${describe(ctx)}`,
      );
    }
    return anchor as CommentAnchor;
  }

  /** Encodes body and anchor of a comment. */
  async encodeComment(comment: CollabComment): Promise<CollabComment> {
    const base = { docName: comment.documentName, kind: 'comment', commentId: comment.id } as const;
    const [body, anchor] = await Promise.all([
      this.encodeText(comment.body, { ...base, field: 'body' }),
      this.encodeAnchor(comment.anchor, { ...base, field: 'anchor' }),
    ]);
    return { ...comment, body, anchor: anchor as unknown as CommentAnchor };
  }

  /** Decodes body and anchor of a stored comment. */
  async decodeComment(comment: CollabComment): Promise<CollabComment> {
    const base = { docName: comment.documentName, kind: 'comment', commentId: comment.id } as const;
    const [body, anchor] = await Promise.all([
      typeof comment.body === 'string'
        ? this.decodeText(comment.body, { ...base, field: 'body' })
        : comment.body,
      this.decodeAnchor(comment.anchor, { ...base, field: 'anchor' }),
    ]);
    return { ...comment, body, anchor };
  }

  /**
   * Decodes a stored document state and records the outcome: after a failure
   * the document is unwritable (see {@link assertWritable}) until a later
   * decode succeeds.
   */
  async decodeDocument(
    stored: Uint8Array,
    docName: string,
    meta?: Record<string, unknown> | null,
  ): Promise<Uint8Array> {
    try {
      const state = await this.decodeBinary(stored, {
        docName,
        kind: 'document',
        field: 'state',
        ...(meta !== undefined ? { meta } : {}),
      });
      this.unreadable.delete(docName);
      return state;
    } catch (error) {
      this.unreadable.add(docName);
      throw error;
    }
  }

  /** The document loaded fine (or has no row): it may be written again. */
  markReadable(docName: string): void {
    this.unreadable.delete(docName);
  }

  /** True while the last decode of this document's stored state failed. */
  isUnreadable(docName: string): boolean {
    return this.unreadable.has(docName);
  }

  /**
   * Refuses a save over a stored state this process failed to decode — the
   * only state such a save can hold is one built without the real content.
   */
  assertWritable(docName: string): void {
    if (this.unreadable.has(docName)) {
      throw new StorageCodecError(
        'previous-state-unreadable',
        { docName, kind: 'document' },
        `refusing to save "${docName}": its stored state could not be decoded, so this save would overwrite it. ` +
          'Fix the codec (or its keys) and load the document again, or call forgetDecodeFailure(docName) to overwrite it on purpose.',
      );
    }
  }
}

/**
 * A storage with a codec applied. `inner` is the wrapped storage, which only
 * ever sees encoded values.
 */
export class CodecStorage implements CollaborationStorage {
  private readonly runner: StorageCodecRunner;

  constructor(
    readonly inner: CollaborationStorage,
    codec: StorageCodec,
  ) {
    this.runner = new StorageCodecRunner(codec);
    // Optional methods exist only when the wrapped storage has them, so the
    // callers' "is it implemented" checks keep meaning what they meant.
    if (!inner.countVersions) delete this.countVersions;
    if (!inner.countComments) delete this.countComments;
    if (!inner.getComment) delete this.getComment;
  }

  async loadDocument(
    docName: string,
  ): Promise<{ state: Uint8Array; meta?: Record<string, unknown> | null } | null> {
    const stored = await this.inner.loadDocument(docName);
    if (!stored?.state || stored.state.byteLength === 0) {
      this.runner.markReadable(docName);
      return stored;
    }
    const state = await this.runner.decodeDocument(stored.state, docName, stored.meta);
    return { ...stored, state };
  }

  async saveDocument(
    docName: string,
    state: Uint8Array,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    this.runner.assertWritable(docName);
    const encoded = await this.runner.encodeBinary(state, {
      docName,
      kind: 'document',
      field: 'state',
      ...(meta !== undefined ? { meta } : {}),
    });
    await this.inner.saveDocument(docName, encoded, meta);
  }

  /** Lets the next save overwrite a document whose stored state failed to decode. */
  forgetDecodeFailure(docName: string): void {
    this.runner.markReadable(docName);
  }

  listVersions(docName: string, page?: ListPageOptions): Promise<CollabVersion[]> {
    return this.inner.listVersions(docName, page);
  }

  countVersions?: (docName: string) => Promise<number> = (docName) =>
    this.inner.countVersions!(docName);

  async saveVersion(docName: string, version: CollabVersion, snapshot: Uint8Array): Promise<void> {
    const encoded = await this.runner.encodeBinary(snapshot, {
      docName,
      kind: 'version',
      field: 'snapshot',
      versionId: version.id,
    });
    await this.inner.saveVersion(docName, version, encoded);
  }

  async loadVersionSnapshot(docName: string, versionId: string): Promise<Uint8Array | null> {
    const stored = await this.inner.loadVersionSnapshot(docName, versionId);
    if (!stored || stored.byteLength === 0) return stored;
    return this.runner.decodeBinary(stored, {
      docName,
      kind: 'version',
      field: 'snapshot',
      versionId,
    });
  }

  pruneVersions(options: PruneVersionsOptions): Promise<number> {
    return this.inner.pruneVersions(options);
  }

  async listComments(
    docName: string,
    space?: string,
    page?: ListPageOptions,
  ): Promise<CollabComment[]> {
    const comments = await this.inner.listComments(docName, space, page);
    return Promise.all(comments.map((comment) => this.runner.decodeComment(comment)));
  }

  countComments?: (docName: string, space?: string) => Promise<number> = (docName, space) =>
    this.inner.countComments!(docName, space);

  getComment?: (docName: string, commentId: string) => Promise<CollabComment | null> = async (
    docName,
    commentId,
  ) => {
    const comment = await this.inner.getComment!(docName, commentId);
    return comment ? this.runner.decodeComment(comment) : null;
  };

  async saveComment(docName: string, comment: CollabComment): Promise<void> {
    await this.inner.saveComment(docName, await this.runner.encodeComment(comment));
  }

  deleteComment(docName: string, commentId: string): Promise<void> {
    return this.inner.deleteComment(docName, commentId);
  }
}

/**
 * Applies `codec` to everything `storage` persists: document state, version
 * snapshots, comment bodies and anchors. For `lucidStorage`, prefer its
 * `codec` option (it also re-encodes legacy rows in batches).
 *
 * @example
 * storage: withCodec(new S3CollabStorage(...), myCodec)
 */
export function withCodec(storage: CollaborationStorage, codec: StorageCodec): CodecStorage {
  return new CodecStorage(storage, codec);
}
