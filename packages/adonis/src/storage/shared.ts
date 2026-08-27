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
