import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as A from '@automerge/automerge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { AutomergeDriver } from '../src/drivers/automerge/automerge_driver.js';
import { InMemoryCollaborationStorage } from '../src/storage/in_memory_storage.js';
import type { CollabPermission } from '../src/types.js';
import { TEST_TOKEN_SECRET, testToken } from './helpers/token.js';

/**
 * The Automerge socket protocol, from both kinds of client.
 *
 * A whole-document client (any client that does not ask for `?sync=changes`)
 * sends `A.save(doc)` and can only read frames `A.load` accepts. A chunk
 * client asks for `?sync=changes`, is acknowledged with a text frame, and
 * from then on exchanges `A.saveSince` chunks. Both can share a room.
 */

const DOC = 'whiteboards/1';
const ACK = 'automerge-sync:changes';
const allow = async (): Promise<CollabPermission> => ({
  canRead: true,
  canWrite: true,
  canComment: true,
});

type Text = { content: string };

/** Pseudo-random text, so a whole save is far bigger than one edit. */
function bigDoc(): A.Doc<Text> {
  let seed = 11;
  const word = () => {
    let out = '';
    for (let i = 0; i < 8; i++) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      out += String.fromCharCode(97 + (seed % 26));
    }
    return out;
  };
  let doc = A.from<Text>({ content: '' });
  for (let i = 0; i < 200; i++) {
    doc = A.change(doc, (d) => {
      A.splice(d, ['content'], d.content.length, 0, `${word()} ${word()} ${word()}\n`);
    });
  }
  return doc;
}

function isWholeDoc(bytes: Uint8Array): boolean {
  try {
    A.load(bytes);
    return true;
  } catch {
    return false;
  }
}

interface Frame {
  binary: boolean;
  data: Uint8Array | string;
}

/** A raw socket with its frames queued, so a test can await them in order. */
class Peer {
  readonly frames: Frame[] = [];
  private waiters: Array<(frame: Frame) => void> = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      const frame: Frame = isBinary
        ? { binary: true, data: new Uint8Array(buffer) }
        : { binary: false, data: buffer.toString('utf8') };
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.frames.push(frame);
    });
  }

  next(timeoutMs = 2000): Promise<Frame> {
    const queued = this.frames.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no frame arrived')), timeoutMs);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  async nextBinary(): Promise<Uint8Array> {
    const frame = await this.next();
    if (!frame.binary) throw new Error(`expected a binary frame, got "${String(frame.data)}"`);
    return frame.data as Uint8Array;
  }

  send(bytes: Uint8Array): void {
    this.ws.send(bytes);
  }
}

const teardown: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of teardown.splice(0).reverse()) await fn();
});

async function setup(options: { seed?: Uint8Array; debounce?: number } = {}) {
  const storage = new InMemoryCollaborationStorage();
  if (options.seed) await storage.saveDocument(DOC, options.seed);
  const saves: Uint8Array[] = [];
  const saveDocument = storage.saveDocument.bind(storage);
  storage.saveDocument = async (docName, state) => {
    saves.push(state);
    return saveDocument(docName, state);
  };

  const driver = new AutomergeDriver({
    authorize: allow,
    tokenSecret: TEST_TOKEN_SECRET,
    storage,
    path: '/collab',
    ...(options.debounce === undefined ? {} : { debounce: options.debounce }),
  });
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await driver.attach(server);
  const { port } = server.address() as AddressInfo;

  const peers: Peer[] = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const peer of peers) peer.ws.terminate();
    await driver.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  teardown.push(close);

  /** Opens a socket and waits for the room's state (and the ack, if asked). */
  const connect = async ({ changes, userId = 'u_1' }: { changes: boolean; userId?: string }) => {
    const query = new URLSearchParams({ doc: DOC, token: testToken(DOC, userId) });
    if (changes) query.set('sync', 'changes');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/collab?${query}`);
    const peer = new Peer(ws);
    peers.push(peer);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    if (changes) expect(await peer.next()).toEqual({ binary: false, data: ACK });
    const state = A.load<Text>(await peer.nextBinary());
    return { peer, state };
  };

  const rooms = () => (driver as unknown as { rooms: Map<string, unknown> }).rooms;

  return { driver, storage, saves, connect, close, rooms };
}

/** Polls `check` until it holds; the driver's saves land on their own schedule. */
async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 1000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('condition never held');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('AutomergeDriver sync protocol', () => {
  it('acknowledges change chunks only to a socket that asked for them', async () => {
    const { connect } = await setup({ seed: A.save(bigDoc()) });

    const whole = await connect({ changes: false });
    const chunked = await connect({ changes: true, userId: 'u_2' });

    expect(chunked.state.content.length).toBeGreaterThan(0);
    // The whole-document socket got its state and nothing else; a text frame
    // would break `A.load` on it.
    expect(whole.peer.frames).toEqual([]);
  });

  it('applies a chunk and forwards it to chunk sockets as a chunk the size of the edit', async () => {
    const seed = A.save(bigDoc());
    const { connect, driver } = await setup({ seed });

    const writer = await connect({ changes: true });
    const reader = await connect({ changes: true, userId: 'u_2' });

    const heads = A.getHeads(writer.state);
    const edited = A.change(writer.state, (d) => {
      A.splice(d, ['content'], 0, 0, 'chunk! ');
    });
    writer.peer.send(A.saveSince(edited, heads));

    const forwarded = await reader.peer.nextBinary();
    expect(isWholeDoc(forwarded)).toBe(false);
    expect(forwarded.byteLength * 10).toBeLessThan(seed.byteLength);
    const applied = A.loadIncremental(reader.state, forwarded);
    expect(applied.content.startsWith('chunk! ')).toBe(true);
    await expect(driver.getDocumentText(DOC)).resolves.toMatch(/^chunk! /);
  });

  it('turns a whole document from an old client into a chunk for chunk sockets', async () => {
    const seed = A.save(bigDoc());
    const { connect } = await setup({ seed });

    const oldClient = await connect({ changes: false });
    const newClient = await connect({ changes: true, userId: 'u_2' });

    const edited = A.change(oldClient.state, (d) => {
      A.splice(d, ['content'], 0, 0, 'old client: ');
    });
    oldClient.peer.send(A.save(edited));

    const forwarded = await newClient.peer.nextBinary();
    expect(forwarded.byteLength * 10).toBeLessThan(seed.byteLength);
    expect(A.loadIncremental(newClient.state, forwarded).content).toMatch(/^old client: /);
  });

  it('gives whole-document clients a whole document when a chunk client edits', async () => {
    const { connect } = await setup({ seed: A.save(bigDoc()) });

    const oldClient = await connect({ changes: false });
    const newClient = await connect({ changes: true, userId: 'u_2' });

    const heads = A.getHeads(newClient.state);
    const edited = A.change(newClient.state, (d) => {
      A.splice(d, ['content'], 0, 0, 'new client: ');
    });
    newClient.peer.send(A.saveSince(edited, heads));

    // Exactly what a client that predates chunks does with a frame.
    const frame = await oldClient.peer.nextBinary();
    const merged = A.merge(oldClient.state, A.load<Text>(frame));
    expect(merged.content).toMatch(/^new client: /);
  });

  it('keeps whole-document clients working among themselves', async () => {
    const { connect } = await setup({ seed: A.save(bigDoc()) });

    const a = await connect({ changes: false });
    const b = await connect({ changes: false, userId: 'u_2' });

    const edited = A.change(a.state, (d) => {
      A.splice(d, ['content'], 0, 0, 'from a: ');
    });
    a.peer.send(A.save(edited));

    const merged = A.merge(b.state, A.load<Text>(await b.peer.nextBinary()));
    expect(merged.content).toMatch(/^from a: /);
  });

  it('converges a room that mixes both kinds of client', async () => {
    const { connect, driver } = await setup({ seed: A.save(bigDoc()) });

    const oldClient = await connect({ changes: false });
    const newClient = await connect({ changes: true, userId: 'u_2' });

    const oldEdit = A.change(oldClient.state, (d) => {
      A.splice(d, ['content'], 0, 0, 'O');
    });
    const heads = A.getHeads(newClient.state);
    const newEdit = A.change(newClient.state, (d) => {
      A.splice(d, ['content'], 0, 0, 'N');
    });
    oldClient.peer.send(A.save(oldEdit));
    newClient.peer.send(A.saveSince(newEdit, heads));

    const oldSide = A.merge(oldEdit, A.load<Text>(await oldClient.peer.nextBinary()));
    const newSide = A.loadIncremental(newEdit, await newClient.peer.nextBinary());
    const server = await driver.getDocumentText(DOC);

    expect(oldSide.content).toBe(server);
    expect(newSide.content).toBe(server);
    expect(server.slice(0, 2).split('').sort()).toEqual(['N', 'O']);
  });

  it('forwards nothing for a payload that adds nothing', async () => {
    const { connect } = await setup({ seed: A.save(bigDoc()) });

    const a = await connect({ changes: false });
    const b = await connect({ changes: true, userId: 'u_2' });

    // The room already holds all of this.
    a.peer.send(A.save(a.state));
    // A later real edit is the first thing b sees.
    const edited = A.change(a.state, (d) => {
      A.splice(d, ['content'], 0, 0, 'real ');
    });
    a.peer.send(A.save(edited));

    const first = await b.peer.nextBinary();
    expect(A.loadIncremental(b.state, first).content).toMatch(/^real /);
    expect(b.peer.frames).toEqual([]);
  });
});

describe('AutomergeDriver room lifecycle', () => {
  it('saves and drops the room when its last client leaves', async () => {
    const { connect, rooms, storage, saves } = await setup();

    const { peer, state } = await connect({ changes: false });
    const observer = await connect({ changes: false, userId: 'u_2' });
    peer.send(
      A.save(
        A.change(state, (d) => {
          d.content = 'kept';
        }),
      ),
    );
    await observer.peer.nextBinary();

    peer.ws.close();
    observer.peer.ws.close();

    // The default debounce is 2 s; leaving does not wait for it.
    await eventually(() => rooms().size === 0, 500);
    expect(saves).toHaveLength(1);
    const stored = await storage.loadDocument(DOC);
    expect(A.load<Text>(stored!.state).content).toBe('kept');

    // And the next client gets it back from the storage.
    const again = await connect({ changes: false });
    expect(again.state.content).toBe('kept');
  });

  it('keeps the room while any client is still connected', async () => {
    const { connect, rooms } = await setup();

    const a = await connect({ changes: false });
    const b = await connect({ changes: false, userId: 'u_2' });
    a.peer.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(rooms().size).toBe(1);
    b.peer.ws.close();
    await eventually(() => rooms().size === 0, 500);
  });

  it('drops a room opened only to answer a read', async () => {
    const { driver, rooms } = await setup({ seed: A.save(A.from({ content: 'read me' })) });

    await expect(driver.getDocumentText(DOC)).resolves.toBe('read me');
    await expect(driver.getDocumentState(DOC)).resolves.toBeInstanceOf(Uint8Array);

    await eventually(() => rooms().size === 0, 500);
  });

  it('writes pending edits on close instead of dropping them', async () => {
    const { connect, driver, storage } = await setup();

    const writer = await connect({ changes: false });
    const observer = await connect({ changes: false, userId: 'u_2' });
    writer.peer.send(
      A.save(
        A.change(writer.state, (d) => {
          d.content = 'written on shutdown';
        }),
      ),
    );
    // The server applied it once it was forwarded.
    await observer.peer.nextBinary();

    // Both clients still connected: only `close` can write it.
    const closing = driver.close();
    await eventually(async () => (await storage.loadDocument(DOC)) !== null, 500);
    const stored = await storage.loadDocument(DOC);
    expect(A.load<Text>(stored!.state).content).toBe('written on shutdown');
    await closing;
  });

  it('saves a document that is edited without pause', async () => {
    const { connect, saves } = await setup();

    const writer = await connect({ changes: false });
    const observer = await connect({ changes: false, userId: 'u_2' });

    // Socket I/O stays real; only the debounce clock is driven by the test.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    let doc = writer.state;
    // An edit every 500 ms for 12 s: the 2 s debounce never gets to elapse.
    for (let i = 0; i < 24; i++) {
      doc = A.change(doc, (d) => {
        A.splice(d, ['content'], 0, 0, 'x');
      });
      writer.peer.send(A.save(doc));
      await observer.peer.next();
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(saves.length).toBeGreaterThanOrEqual(1);
    expect(A.load<Text>(saves[0]!).content.length).toBeGreaterThanOrEqual(20);
  });
});
