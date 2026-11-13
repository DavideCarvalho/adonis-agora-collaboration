import { flags } from '@adonisjs/core/ace';
import { CollaborationCommand } from './cli_shared.js';

/**
 * `node ace collaboration:documents:show --doc=<name> [--json]` — one document without
 * opening it: declaration, engine, stored size, versions, comments and presence.
 */
export default class CollaborationDocumentsShow extends CollaborationCommand {
  static override commandName = 'collaboration:documents:show';
  static override description =
    'Show one document: engine, stored size, versions, comments, presence';

  @flags.string({ description: 'Document name (e.g. researches/42/writing)' })
  declare doc?: string;

  @flags.boolean({ description: 'Print JSON' })
  declare json?: boolean;

  override async run(): Promise<void> {
    const docName = this.docName(this.doc);
    const manager = await this.manager();
    const doc = await manager.describeDocument({ docName });
    if (this.json) return this.printJson(doc);
    const table = this.ui.table();
    table.head(['Field', 'Value']);
    table.row(['Document', doc.docName]);
    table.row(['Pattern', doc.pattern ?? '(none declared)']);
    const params = Object.entries(doc.params);
    if (params.length > 0) table.row(['Params', params.map(([k, v]) => `${k}=${v}`).join(', ')]);
    table.row(['Engine', doc.engine]);
    table.row(['Stored', doc.storedBytes === null ? 'nothing stored' : `${doc.storedBytes} bytes`]);
    table.row(['Versions', String(doc.versions)]);
    table.row(['Comments', String(doc.comments)]);
    table.row(['Presence', String(doc.presence)]);
    table.render();
    if (doc.storage === 'memory') {
      this.logger.warning(
        'No storage configured: this reads the memory of this process only, not your running app.',
      );
    }
  }
}
