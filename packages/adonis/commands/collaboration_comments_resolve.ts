import { args, flags } from '@adonisjs/core/ace';
import { CollaborationCommand } from './cli_shared.js';

/**
 * `node ace collaboration:comments:resolve <commentId> --doc=<name> [--reopen] [--json]` —
 * resolve (or reopen) a comment, as `PATCH /collaboration/comments/:id` does.
 */
export default class CollaborationCommentsResolve extends CollaborationCommand {
  static override commandName = 'collaboration:comments:resolve';
  static override description = 'Resolve a comment (or reopen it with --reopen)';

  @args.string({ description: 'Comment id' })
  declare commentId: string;

  @flags.string({ description: 'Document name' })
  declare doc?: string;

  @flags.boolean({ description: 'Reopen a resolved comment instead' })
  declare reopen?: boolean;

  @flags.boolean({ description: 'Print the comment as JSON' })
  declare json?: boolean;

  override async run(): Promise<void> {
    const docName = this.docName(this.doc);
    const manager = await this.manager();
    const comment = await manager.comments.resolve(docName, this.commentId, !this.reopen);
    if (!comment) throw new Error(`No comment ${this.commentId} on '${docName}'.`);
    if (this.json) return this.printJson(comment);
    this.logger.success(`Comment ${comment.id} ${this.reopen ? 'reopened' : 'resolved'}.`);
  }
}
