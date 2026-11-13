import { args, flags } from '@adonisjs/core/ace';
import { CollaborationCommand } from './cli_shared.js';

/**
 * `node ace collaboration:comments:delete <commentId> --doc=<name> [--force]` — delete a
 * comment, as `DELETE /collaboration/comments/:id` does. Asks first unless `--force`.
 */
export default class CollaborationCommentsDelete extends CollaborationCommand {
  static override commandName = 'collaboration:comments:delete';
  static override description = 'Delete a comment';

  @args.string({ description: 'Comment id' })
  declare commentId: string;

  @flags.string({ description: 'Document name' })
  declare doc?: string;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force?: boolean;

  override async run(): Promise<void> {
    const docName = this.docName(this.doc);
    const manager = await this.manager();
    const comment = await manager.comments.get(docName, this.commentId);
    if (!comment) throw new Error(`No comment ${this.commentId} on '${docName}'.`);
    const confirmed = await this.confirmOrForce(
      this.force,
      `Delete comment ${comment.id} by ${comment.authorName ?? comment.userId} on '${docName}'? This cannot be undone.`,
    );
    if (!confirmed) return;
    await manager.comments.remove(docName, this.commentId);
    this.logger.success(`Comment ${this.commentId} deleted.`);
  }
}
