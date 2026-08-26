import * as Y from 'yjs';
import type { CollabTokenInfo, CollabTransport, TransportFactory } from '../types.js';
import { HocuspocusCollabTransport } from './hocuspocus.js';
import { PartyKitCollabTransport } from './partykit.js';
import { PartyServerCollabTransport } from './partyserver.js';

/** Factory default: escolhe o transporte pelo engine informado pelo server. */
export const defaultTransportFactory: TransportFactory = (
  info: CollabTokenInfo,
  doc: Y.Doc,
  docName: string,
): CollabTransport => {
  if (info.engine === 'partykit') {
    return new PartyKitCollabTransport(info, doc, docName);
  }
  if (info.engine === 'partyserver') {
    return new PartyServerCollabTransport(info, doc, docName);
  }
  // yjs self-hosted (hocuspocus embutido). Automerge client ainda não tem
  // provider aqui — erro explícito no session.start().
  return new HocuspocusCollabTransport(info, doc, docName);
};
