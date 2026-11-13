import { offsetPage } from '@adonis-agora/filter';
import { flags } from '@adonisjs/core/ace';
import { CollaborationCommand } from './cli_shared.js';

/**
 * `node ace collaboration:comments:list --doc=<name> [--space] [--page] [--size] [--order]
 * [--json]` — a document's comments, as `GET /collaboration/comments` returns them.
 */
export default class CollaborationCommentsList extends CollaborationCommand {
  static override commandName = 'collaboration:comments:list';
  static override description = 'List the comments of a document';

  @flags.string({ description: 'Document name' })
  declare doc?: string;

  @flags.string({ description: "Only this space ('text', 'canvas', …)" })
  declare space?: string;

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
    const space = this.space?.trim() || undefined;
    const manager = await this.manager();
    const [rows, total] = await Promise.all([
      manager.comments.list(docName, space, { page, size, order }),
      manager.comments.count(docName, space),
    ]);
    const result = offsetPage(rows, { total, page, size });
    if (this.json) return this.printJson(result);
    if (total === 0) {
      this.logger.info(`'${docName}' has no comments${space ? ` in '${space}'` : ''}.`);
      return;
    }
    const table = this.ui.table();
    table.head(['Id', 'Space', 'Author', 'Body', 'Created at', 'Resolved at']);
    for (const c of result.data) {
      const body = c.body.length > 60 ? `${c.body.slice(0, 57)}...` : c.body;
      table.row([
        c.id,
        c.space,
        c.authorName ?? c.userId,
        body.replace(/\s+/g, ' '),
        c.createdAt,
        c.resolvedAt ?? '',
      ]);
    }
    table.render();
    this.pageFooter(result.meta);
  }
}
