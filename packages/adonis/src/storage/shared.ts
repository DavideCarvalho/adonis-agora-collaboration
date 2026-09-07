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
 * Shared paging bounds for {@link import('../types.js').ListPageOptions}.
 *
 * Every storage implementation clamps through these rather than picking its
 * own numbers — a page size that differs between `LucidStorage` and
 * `InMemoryCollaborationStorage` turns "it works in the tests" into a claim
 * about the wrong store. Mirrors the convention already used for billing
 * lists in `@adonis-agora/payments` (`BILLING_LIST_DEFAULT_LIMIT`/`_MAX_LIMIT`).
 */

/** Rows returned when a page is requested with no particular size. */
export const COLLAB_LIST_DEFAULT_LIMIT = 50;

/** Hard ceiling — an unbounded `limit` from a query string must not be able to select the table. */
export const COLLAB_LIST_MAX_LIMIT = 200;

/** Clamp a requested page size into `1..COLLAB_LIST_MAX_LIMIT`, defaulting when absent/invalid. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return COLLAB_LIST_DEFAULT_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) return COLLAB_LIST_DEFAULT_LIMIT;
  return Math.min(floored, COLLAB_LIST_MAX_LIMIT);
}

/** Clamp a requested offset to a non-negative integer, defaulting to `0`. */
export function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  const floored = Math.floor(offset);
  return floored < 0 ? 0 : floored;
}
