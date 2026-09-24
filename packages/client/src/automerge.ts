/**
 * `@adonis-agora/collaboration-client/automerge` — the Automerge hook, off the main entry.
 *
 * Automerge ships WebAssembly. Re-exported from the root barrel, it was loaded eagerly by every
 * Yjs-only app during hydration; importing it from this subpath keeps that cost to the apps
 * that use it.
 */
export type { UseAutomergeDocResult } from './hooks/use_automerge_doc.js';
export { useAutomergeDoc } from './hooks/use_automerge_doc.js';
