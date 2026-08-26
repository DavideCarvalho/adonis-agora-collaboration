import { InMemoryCollaborationStorage } from '../storage/in_memory_storage.js';
import type { CollaborationStorage } from '../types.js';

/**
 * Pure helpers shared by every driver. Nothing here knows about transports
 * or engines — drivers stay connected only through the registry.
 */

/** Resolves the storage dependency, defaulting to in-memory (dev only). */
export function resolveStorage(storage?: CollaborationStorage): CollaborationStorage {
  return storage ?? new InMemoryCollaborationStorage();
}

/** Line-based diff summary — added/removed counts between two texts. */
export function lineDiff(a: string, b: string): { added: number; removed: number } {
  const linesA = new Set(a.split('\n'));
  const linesB = new Set(b.split('\n'));

  let added = 0;
  for (const line of linesB) if (!linesA.has(line)) added++;
  let removed = 0;
  for (const line of linesA) if (!linesB.has(line)) removed++;

  return { added, removed };
}

type JsonNode = Record<string, unknown>;

/** Converts a Tiptap JSON document into plain text (\n\n between blocks). */
export function tiptapJsonToText(node: JsonNode | null | undefined): string {
  if (!node || !Array.isArray(node.content)) return '';

  let text = '';
  const walk = (current: JsonNode) => {
    if (current.type === 'text' && typeof current.text === 'string') {
      text += current.text;
      return;
    }
    if (Array.isArray(current.content)) {
      for (const child of current.content as JsonNode[]) walk(child);
    }
    if (
      typeof current.type === 'string' &&
      ['paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem'].includes(current.type)
    ) {
      text += '\n\n';
    }
  };
  walk(node);
  return text.trimEnd();
}
