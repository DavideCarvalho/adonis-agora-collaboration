import { userInfo } from 'node:os';
import { BaseCommand } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { CollaborationManager } from '../src/collaboration_manager.js';
import { listPageOf } from '../src/http/list_api.js';
import type { ListOrder } from '../src/types.js';

/** Who a command acts as in `createdBy` / `restoredBy`: `cli:<os user>`. */
export function cliActor(): string {
  try {
    return `cli:${userInfo().username}`;
  } catch {
    // containers without a passwd entry
    return 'cli';
  }
}

/**
 * Base of the `collaboration:<noun>:<verb>` commands: boots the app (the
 * provider never attaches the WebSocket outside the web environment), resolves
 * the {@link CollaborationManager} the REST routes use, and turns a refused
 * input into one error line and exit code 1.
 */
export abstract class CollaborationCommand extends BaseCommand {
  static override options: CommandOptions = { startApp: true };

  override async completed() {
    const error = this.error as unknown;
    if (
      error instanceof Error &&
      !(error instanceof TypeError) &&
      !(error instanceof ReferenceError) &&
      !(error instanceof SyntaxError)
    ) {
      this.logger.error(error.message);
      this.exitCode = 1;
      return true;
    }
    return false;
  }

  protected manager(): Promise<CollaborationManager> {
    return this.app.container.make(CollaborationManager);
  }

  /** `--doc`, required and non-empty. */
  protected docName(doc: string | undefined): string {
    const name = doc?.trim() ?? '';
    if (name === '') throw new Error('--doc is required: the document name');
    return name;
  }

  /** `--page` / `--size` / `--order` under the same paging policy as the REST listings. */
  protected paging(
    page: number | undefined,
    size: number | undefined,
    order: string | undefined,
  ): { page: number; size: number; order: ListOrder } {
    for (const [flag, value] of [
      ['--page', page],
      ['--size', size],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
        throw new Error(`${flag} must be a positive integer`);
      }
    }
    if (order !== undefined && order !== 'asc' && order !== 'desc') {
      throw new Error('--order must be asc or desc');
    }
    return {
      ...listPageOf({
        ...(page !== undefined ? { page: String(page) } : {}),
        ...(size !== undefined ? { size: String(size) } : {}),
      }),
      order: order ?? 'asc',
    };
  }

  protected printJson(value: unknown): void {
    this.logger.log(JSON.stringify(value, null, 2));
  }

  /** "page 1 of 3 (120 total)" under a table. */
  protected pageFooter(meta: { currentPage: number; lastPage: number; total: number }): void {
    this.logger.info(`page ${meta.currentPage} of ${meta.lastPage} (${meta.total} total)`);
  }

  /**
   * Ask before a destructive action unless `--force`. Without a terminal it
   * refuses. Returns `false` when the user said no (exit code already 1).
   */
  protected async confirmOrForce(force: boolean | undefined, question: string): Promise<boolean> {
    if (force) return true;
    if (process.stdin.isTTY !== true) {
      throw new Error('This needs confirmation: run it in a terminal or pass --force.');
    }
    if (await this.prompt.confirm(question)) return true;
    this.logger.warning('Cancelled.');
    this.exitCode = 1;
    return false;
  }
}
