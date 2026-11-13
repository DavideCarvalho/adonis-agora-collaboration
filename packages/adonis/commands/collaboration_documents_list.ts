import { flags } from '@adonisjs/core/ace';
import { CollaborationCommand } from './cli_shared.js';

/**
 * `node ace collaboration:documents:list [--json]` — the `documents` declared in
 * `config/collaboration.ts`: pattern, params, engine and which hooks each one has.
 */
export default class CollaborationDocumentsList extends CollaborationCommand {
  static override commandName = 'collaboration:documents:list';
  static override description = 'List the document patterns declared in config/collaboration.ts';

  @flags.boolean({ description: 'Print JSON' })
  declare json?: boolean;

  override async run(): Promise<void> {
    const manager = await this.manager();
    const documents = manager.listDocumentDeclarations();
    if (this.json) return this.printJson({ data: documents });
    if (documents.length === 0) {
      this.logger.info(
        `No documents declared in config/collaboration.ts — every document uses the global authorize and the "${manager.engine}" engine.`,
      );
      return;
    }
    const table = this.ui.table();
    table.head(['Pattern', 'Params', 'Engine', 'Own authorize', 'Seeds (load)']);
    for (const doc of documents) {
      table.row([
        doc.pattern,
        doc.params.join(', '),
        doc.engine,
        doc.authorize ? 'yes' : 'no',
        doc.load ? 'yes' : 'no',
      ]);
    }
    table.render();
  }
}
