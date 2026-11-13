import { args, flags } from '@adonisjs/core/ace';
import { CollaborationCommand, cliActor } from './cli_shared.js';

/**
 * `node ace collaboration:versions:restore <versionId> --doc=<name> [--force]` — bring a
 * document back to a version, as `POST /collaboration/versions/restore` does, with
 * `restoredBy: 'cli:<os user>'`. The current state is kept as a version first.
 *
 * Asks first unless `--force` (refuses without a terminal). Refuses a self-hosted
 * (yjs/automerge) document that has people in presence: the server holding it open
 * would persist its own copy over the restore.
 */
export default class CollaborationVersionsRestore extends CollaborationCommand {
  static override commandName = 'collaboration:versions:restore';
  static override description = 'Restore a document to one of its versions';

  @args.string({ description: 'Version id (from collaboration:versions:list)' })
  declare versionId: string;

  @flags.string({ description: 'Document name' })
  declare doc?: string;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force?: boolean;

  override async run(): Promise<void> {
    const docName = this.docName(this.doc);
    const manager = await this.manager();
    const engine = await manager.engineFor({ docName });
    if (engine === 'yjs' || engine === 'automerge') {
      const present = await manager.listPresence({ docName });
      if (present.length > 0) {
        throw new Error(
          `'${docName}' has ${present.length} people connected (presence) — restore it from the app, or when nobody has it open`,
        );
      }
    }
    const confirmed = await this.confirmOrForce(
      this.force,
      `Restore '${docName}' to version ${this.versionId}? The current state is kept as a version.`,
    );
    if (!confirmed) return;
    await manager.restoreVersion({ docName, versionId: this.versionId, restoredBy: cliActor() });
    this.logger.success(`'${docName}' restored to version ${this.versionId}.`);
  }
}
