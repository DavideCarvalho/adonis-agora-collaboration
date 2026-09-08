import type { ListPageOptions } from '../types.js';

/**
 * Pure helpers shared by every storage implementation. Nothing here touches a
 * backend — it is the validation the three built-ins (and any custom storage)
 * run before deleting anything.
 */

/**
 * Guards `pruneVersions`. `keep: 0` is a legitimate "delete every version",
 * so the check has to reject the *accidents* instead: a negative number, a
 * fraction, `NaN` from a mis-parsed flag. Silently treating those as zero
 * would wipe the history the caller meant to keep.
 */
export function assertPruneKeep(keep: number): void {
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error(
      `[@adonis-agora/collaboration] pruneVersions requires \`keep\` to be a non-negative integer — received ${String(keep)}`,
    );
  }
}

/** The versions to delete: everything past the `keep` most recent ones. */
export function versionsToPrune<T extends { seq: number }>(versions: T[], keep: number): T[] {
  return [...versions].sort((a, b) => b.seq - a.seq).slice(keep);
}

/**
 * Shared paging bounds for {@link ListPageOptions}.
 *
 * Every storage implementation clamps through these rather than picking its
 * own numbers — a page size that differs between `LucidStorage` and
 * `InMemoryCollaborationStorage` turns "it works in the tests" into a claim
 * about the wrong store. The `{ page, size }` vocabulary intentionally mirrors
 * `@adonis-agora/filter`'s pagination shape — matched structurally, without a
 * dependency — so every `@adonis-agora/*` package pages the same way.
 */

/** Rows returned when a page is requested with no particular size. */
export const COLLAB_LIST_DEFAULT_SIZE = 50;

/** Hard ceiling — an unbounded `size` from a query string must not be able to select the table. */
export const COLLAB_LIST_MAX_SIZE = 200;

/** Clamp a requested page size into `1..COLLAB_LIST_MAX_SIZE`, defaulting when absent/invalid. */
export function clampSize(size: number | undefined): number {
  if (size === undefined || !Number.isFinite(size)) return COLLAB_LIST_DEFAULT_SIZE;
  const floored = Math.floor(size);
  if (floored < 1) return COLLAB_LIST_DEFAULT_SIZE;
  return Math.min(floored, COLLAB_LIST_MAX_SIZE);
}

/** Clamp a requested 1-based page number, defaulting to the first page. */
export function clampPage(page: number | undefined): number {
  if (page === undefined || !Number.isFinite(page)) return 1;
  const floored = Math.floor(page);
  return floored < 1 ? 1 : floored;
}

/**
 * Resolves the public `{ page, size }` request into the `{ size, offset }` a
 * store actually needs. The 0-based offset is derived here and nowhere else:
 * it is an implementation detail of SQL (and of `Array.prototype.slice`), not
 * something a caller of `CollaborationStorage` should have to know about.
 */
export function resolvePage(page: ListPageOptions): { size: number; offset: number } {
  const size = clampSize(page.size);
  return { size, offset: (clampPage(page.page) - 1) * size };
}
