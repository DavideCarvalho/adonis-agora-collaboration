import { BaseCommand, flags } from '@adonisjs/core/ace';
import { CollaborationManager } from '../src/collaboration_manager.js';

/**
 * `node ace collaboration:prune --keep=20`
 *
 * Applies a retention policy to the version history: keeps the `--keep` most
 * recent versions of **each** document and deletes the rest. `keep` is per
 * document, so a document versioned every minute never evicts the history of
 * one versioned twice a year.
 *
 * There is no automatic retention in the library — run this from cron or a
 * scheduler at whatever interval your version rate justifies. The same call
 * from code is `collaboration.current.pruneVersions({ keep })`.
 */
export default class CollaborationPrune extends BaseCommand {
  static override commandName = 'collaboration:prune';
  static override description = 'Delete all but the N most recent versions of each document';
  static override options = { startApp: true };

  @flags.number({ description: 'Versions to keep per document (default 20)' })
  declare keep?: number;

  @flags.string({ description: 'Prune a single document instead of every one' })
  declare doc?: string;

  @flags.boolean({ description: 'Report what would be deleted without deleting anything' })
  declare dryRun?: boolean;

  override async run(): Promise<void> {
    const keep = this.keep ?? 20;
    const manager = await this.app.container.make(CollaborationManager);

    let removed: number;
    try {
      removed = await manager.pruneVersions({
        keep,
        ...(this.doc ? { docName: this.doc } : {}),
        ...(this.dryRun ? { dryRun: true } : {}),
      });
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
      this.exitCode = 1;
      return;
    }

    const scope = this.doc ? `document '${this.doc}'` : 'all documents';
    if (this.dryRun) {
      this.logger.info(
        `dry run: ${removed} version(s) would be deleted from ${scope}, keeping ${keep} per document`,
      );
      return;
    }

    this.logger.action(`prune ${scope}`).succeeded();
    this.logger.success(`${removed} version(s) deleted, keeping ${keep} per document.`);
  }
}
