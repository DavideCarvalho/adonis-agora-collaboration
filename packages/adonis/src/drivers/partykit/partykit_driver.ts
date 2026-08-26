import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import type { CollaborationDriver, PartyKitDriverOptions } from '../../driver.js';
import type { CollabDiffSummary, CollabVersion, CollaborationStorage } from '../../types.js';
import { createVersionMetadata, seqVersions } from '../../versioning.js';
import { lineDiff, resolveStorage, tiptapJsonToText } from '../shared.js';

/**
 * PartyKit driver (edge sync).
 *
 * Unlike the Yjs/Automerge drivers, the transport is NOT attached to the
 * Adonis HTTP server: PartyKit runs as a standalone Worker (Cloudflare
 * Durable Objects) on its own origin and browsers connect to it directly.
 * This driver is the worker's HTTP client — `attach()` is an intentional
 * no-op.
 *
 * Responsibilities:
 *  - `getDocumentState`/`getDocumentText`: GET the worker's `onRequest`;
 *  - `restoreVersion`: POST the binary update to the live doc (edge broadcast);
 *  - version control + comments: stay in Adonis (injected storage),
 *    fetching the current room state over HTTP before snapshotting.
 *
 * The worker template (`stubs/partykit/worker/`) is published by
 * `collaboration:init --engine=partykit`.
 */

export { signPartyKitToken, verifyPartyKitToken } from '../../auth/token.js';

/** Typed error for non-2xx worker responses. */
export class PartyKitRoomError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly docName: string,
  ) {
    super(`PartyKit room "${docName}" responded ${status}: ${body}`);
    this.name = 'PartyKitRoomError';
  }
}

export class PartyKitDriver implements CollaborationDriver {
  readonly engine = 'partykit';

  private readonly options: PartyKitDriverOptions;
  private readonly storage: CollaborationStorage;

  constructor(options: PartyKitDriverOptions) {
    this.options = options;
    this.storage = resolveStorage(options.storage);
  }

  /** Validates the partykit config (throws a clear message when absent). */
  private partyConfig() {
    const pk = this.options.partykit;
    if (!pk?.roomHost) {
      throw new Error(
        "[@adonis-agora/collaboration] engine 'partykit' requires config.partykit.roomHost " +
          '(the deployment host, e.g. my-app.partykit.dev)',
      );
    }
    return pk;
  }

  /** Room HTTP endpoint URL on the worker. */
  private roomUrl(docName: string): string {
    const pk = this.partyConfig();
    const host = pk.roomHost.replace(/^https?:\/\//, '');
    const scheme = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
    return `${scheme}://${host}/parties/${pk.party ?? 'main'}/${encodeURIComponent(docName)}`;
  }

  /** Authenticated HTTP call to the worker's `onRequest`. */
  private async roomRequest(
    docName: string,
    init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: Uint8Array },
  ): Promise<Response> {
    const pk = this.partyConfig();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), pk.fetchTimeoutMs ?? 10_000);
    try {
      const requestInit: RequestInit = {
        method: init.method,
        headers: init.headers ?? {},
        signal: controller.signal,
      };
      if (init.body) {
        requestInit.body = init.body as unknown as NonNullable<RequestInit['body']>;
      }
      return await fetch(this.roomUrl(docName), requestInit);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Intentional no-op: the WebSocket lives in the PartyKit worker, not the
   * Node server. Kept on the interface for provider lifecycle compatibility
   * (which calls attach during ready()).
   */
  async attach(_server: import('node:http').Server): Promise<void> {
    void _server;
  }

  async getDocumentState(docName: string): Promise<Uint8Array> {
    const response = await this.roomRequest(docName, {
      method: 'GET',
      headers: { 'x-collab-return': 'update' },
    });
    if (!response.ok) {
      throw new PartyKitRoomError(response.status, await response.text(), docName);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async getDocumentText(docName: string): Promise<string> {
    const response = await this.roomRequest(docName, {
      method: 'GET',
      headers: { 'x-collab-return': 'text' },
    });
    if (!response.ok) {
      throw new PartyKitRoomError(response.status, await response.text(), docName);
    }
    return response.text();
  }

  async createVersion(
    docName: string,
    createdBy: string | null,
    label: string | null,
  ): Promise<CollabVersion> {
    // Snapshots the current edge room state into the local storage.
    const state = await this.getDocumentState(docName);
    const existing = await this.storage.listVersions(docName);
    const version = createVersionMetadata(createdBy, label, seqVersions(existing));
    await this.storage.saveVersion(docName, version, state);
    return version;
  }

  async listVersions(docName: string): Promise<CollabVersion[]> {
    return this.storage.listVersions(docName);
  }

  async restoreVersion(
    docName: string,
    versionId: string,
    restoredBy: string | null,
  ): Promise<void> {
    void restoredBy;
    const snapshot = await this.storage.loadVersionSnapshot(docName, versionId);
    if (!snapshot) throw new Error(`Version ${versionId} not found`);

    // POSTs the full snapshot: the worker applies the update to the live
    // doc (idempotent CRDT merge) and the protocol fans out to clients.
    const response = await this.roomRequest(docName, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: snapshot,
    });
    if (!response.ok) {
      throw new PartyKitRoomError(response.status, await response.text(), docName);
    }
    await this.storage.saveDocument(docName, snapshot);
  }

  async diffVersions(docName: string, aId: string, bId: string): Promise<CollabDiffSummary> {
    const [aBytes, bBytes] = await Promise.all([
      this.storage.loadVersionSnapshot(docName, aId),
      this.storage.loadVersionSnapshot(docName, bId),
    ]);
    if (!aBytes || !bBytes) throw new Error('Version not found');

    const textOf = (bytes: Uint8Array): string => {
      try {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, bytes);
        const json = TiptapTransformer.fromYdoc(doc) as unknown as Record<string, unknown>;
        const defaultDoc = (json as { default?: Record<string, unknown> }).default ?? json;
        return tiptapJsonToText(defaultDoc);
      } catch {
        return '';
      }
    };

    return lineDiff(textOf(aBytes), textOf(bBytes));
  }

  async close(): Promise<void> {
    // No local resources: no WS server, timers or open connections.
  }
}
