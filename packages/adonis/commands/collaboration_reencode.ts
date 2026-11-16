import { BaseCommand, flags } from '@adonisjs/core/ace';
import { lucidStorageOf } from '../src/storage/lucid_storage.js';

/**
 * `node ace collaboration:reencode`
 *
 * Encodes, with the `codec` of `lucidStorage({ codec })`, every row written
 * before the codec was configured: document state, version snapshots, comment
 * bodies and anchors. Already-encoded rows are skipped, so the command can be
 * interrupted and run again.
 */
export default class CollaborationReencode extends BaseCommand {
  static override commandName = 'collaboration:reencode';
  static override description =
    'Encode stored documents, versions and comments written before the storage codec was set';
  static override options = { startApp: true };

  @flags.number({ description: 'Rows read per query (default 100)' })
  declare batchSize?: number;

  @flags.boolean({ description: 'Count what would be encoded without writing anything' })
  declare dryRun?: boolean;

  override async run(): Promise<void> {
    const config = this.app.config.get<{ storage?: unknown }>('collaboration', {});
    const storage = lucidStorageOf(config.storage);
    if (!storage?.hasCodec) {
      this.logger.error(
        'collaboration:reencode needs `storage: lucidStorage({ codec })` in config/collaboration.ts',
      );
      this.exitCode = 1;
      return;
    }

    try {
      const result = await storage.reencodeAll({
        ...(this.batchSize !== undefined ? { batchSize: this.batchSize } : {}),
        ...(this.dryRun ? { dryRun: true } : {}),
      });
      const summary = `${result.documents} document(s), ${result.versions} version(s), ${result.comments} comment(s)`;
      if (this.dryRun) this.logger.info(`dry run: would encode ${summary}`);
      else this.logger.success(`encoded ${summary}`);
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
      this.exitCode = 1;
    }
  }
}
