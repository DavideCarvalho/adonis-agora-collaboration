import { flags } from '@adonisjs/core/ace';
import { CollaborationCommand, cliActor } from './cli_shared.js';

/**
 * `node ace collaboration:versions:create --doc=<name> [--label] [--json]` — snapshot a
 * document's current stored state, as `POST /collaboration/versions` does, with
 * `createdBy: 'cli:<os user>'`.
 */
export default class CollaborationVersionsCreate extends CollaborationCommand {
  static override commandName = 'collaboration:versions:create';
  static override description = 'Create a version (snapshot) of a document';

  @flags.string({ description: 'Document name' })
  declare doc?: string;

  @flags.string({ description: 'Version label' })
  declare label?: string;

  @flags.boolean({ description: 'Print the version as JSON' })
  declare json?: boolean;

  override async run(): Promise<void> {
    const docName = this.docName(this.doc);
    const manager = await this.manager();
    const version = await manager.createVersion({
      docName,
      createdBy: cliActor(),
      label: this.label ?? null,
    });
    if (this.json) return this.printJson(version);
    this.logger.success(`Version #${version.seq} (${version.id}) created for '${docName}'.`);
  }
}
