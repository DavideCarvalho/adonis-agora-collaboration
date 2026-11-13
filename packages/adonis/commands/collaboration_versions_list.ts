import { offsetPage } from '@adonis-agora/filter';
import { flags } from '@adonisjs/core/ace';
import { CollaborationCommand } from './cli_shared.js';

/**
 * `node ace collaboration:versions:list --doc=<name> [--page] [--size] [--order] [--json]` —
 * the version history of a document, as `GET /collaboration/versions` returns it.
 */
export default class CollaborationVersionsList extends CollaborationCommand {
  static override commandName = 'collaboration:versions:list';
  static override description = 'List the versions of a document';

  @flags.string({ description: 'Document name' })
  declare doc?: string;

  @flags.number({ description: 'Page, from 1' })
  declare page?: number;

  @flags.number({ description: 'Page size (default 50, at most 200)' })
  declare size?: number;

  @flags.string({ description: 'asc (oldest first, default) or desc' })
  declare order?: string;

  @flags.boolean({ description: 'Print JSON ({ data, meta })' })
  declare json?: boolean;

  override async run(): Promise<void> {
    const docName = this.docName(this.doc);
    const { page, size, order } = this.paging(this.page, this.size, this.order);
    const manager = await this.manager();
    const [rows, total] = await Promise.all([
      manager.listVersions({ docName, page, size, order }),
      manager.countVersions({ docName }),
    ]);
    const result = offsetPage(rows, { total, page, size });
    if (this.json) return this.printJson(result);
    if (total === 0) {
      this.logger.info(`'${docName}' has no versions.`);
      return;
    }
    const table = this.ui.table();
    table.head(['#', 'Id', 'Label', 'Created at', 'Created by']);
    for (const v of result.data) {
      table.row([String(v.seq), v.id, v.label ?? '', v.createdAt, v.createdBy ?? '']);
    }
    table.render();
    this.pageFooter(result.meta);
  }
}
