import { BaseCommand, flags } from '@adonisjs/core/ace';
import { CollaborationManager } from '../src/collaboration_manager.js';

/**
 * `node ace collaboration:compact --doc=researches/42/writing`
 *
 * Rewrites one stored document without the history of content it no longer
 * has (Yjs keeps every deleted item as a tombstone). The old state is kept as a
 * `before compaction` version. Refuses a document that is open or has people
 * connected — see `YjsDriver.compactDocument` for why it matters.
 */
export default class CollaborationCompact extends BaseCommand {
  static override commandName = 'collaboration:compact';
  static override description = 'Rewrite a stored document without its deleted history';
  static override options = { startApp: true };

  @flags.string({ description: 'Document to compact', required: true })
  declare doc: string;

  @flags.boolean({ description: 'Report the sizes without writing anything' })
  declare dryRun?: boolean;

  override async run(): Promise<void> {
    const manager = await this.app.container.make(CollaborationManager);

    let result: { before: number; after: number };
    try {
      result = await manager.compactDocument({
        docName: this.doc,
        ...(this.dryRun ? { dryRun: true } : {}),
      });
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
      this.exitCode = 1;
      return;
    }

    const sizes = `${result.before} → ${result.after} bytes`;
    if (this.dryRun) {
      this.logger.info(`dry run: '${this.doc}' would go ${sizes}`);
      return;
    }
    if (result.after >= result.before) {
      this.logger.info(
        `'${this.doc}' is already compact (${result.before} bytes) — nothing written`,
      );
      return;
    }
    this.logger.success(`'${this.doc}' compacted: ${sizes}`);
  }
}
