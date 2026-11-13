import {
  applyCustomFilter,
  BaseFilter,
  InvalidColumnFilterError,
  parsePageParams,
  resolveSort,
} from '@adonis-agora/filter';
import { COLLAB_LIST_DEFAULT_SIZE, COLLAB_LIST_MAX_SIZE } from '../storage/shared.js';
import type { ListOrder } from '../types.js';

/**
 * The listing side of the built-in routes: the `@adonis-agora/filter` wire
 * format (`filter[field]=…`, `sort=…`, `page`/`size`) translated into the
 * storage's `{ space, page, size, order }`.
 */

/** What a filtered comment listing narrows to. */
export class CommentQueryDraft {
  space: string | undefined;
}

/** What a filtered version listing narrows to — no filterable field yet. */
export class VersionQueryDraft {}

/** `filter[space]=text` — one space, equality only. */
export class CommentFilter extends BaseFilter<CommentQueryDraft> {
  declare $query: CommentQueryDraft;

  space(value: unknown, operator: string): void {
    if (operator !== 'equals') {
      throw new InvalidColumnFilterError(`"space" does not support the "${operator}" operator.`);
    }
    const first = Array.isArray(value) ? value[0] : value;
    if (first === undefined || first === null || first === '') return;
    this.$query.space = String(first);
  }
}

/** Versions expose no filter field: any `filter[…]` is a 400. */
export class VersionFilter extends BaseFilter<VersionQueryDraft> {
  declare $query: VersionQueryDraft;
}

/** Offset paging, shared policy: 1-based `page`, `size` default 50, max 200. */
export function listPageOf(qs: Record<string, unknown>): { page: number; size: number } {
  return parsePageParams(qs, {
    defaultSize: COLLAB_LIST_DEFAULT_SIZE,
    maxSize: COLLAB_LIST_MAX_SIZE,
  });
}

/**
 * The one order a listing supports (`field` ascending) or its reverse
 * (`-field`). Anything else throws {@link InvalidColumnFilterError}.
 */
export function listOrderOf(qs: Record<string, unknown>, field: 'createdAt' | 'seq'): ListOrder {
  const [first, ...rest] = resolveSort(qs.sort as string | undefined, {
    sortable: [field],
    default: field,
  });
  if (rest.length > 0) {
    throw new InvalidColumnFilterError(`Sort accepts a single field: "${field}" or "-${field}".`);
  }
  return first?.direction ?? 'asc';
}

/** Parses the comment listing request. Throws {@link InvalidColumnFilterError} on a bad field. */
export async function parseCommentList(qs: Record<string, unknown>): Promise<{
  space: string | undefined;
  page: number;
  size: number;
  order: ListOrder;
}> {
  const draft = new CommentQueryDraft();
  await applyCustomFilter(draft, CommentFilter, { request: { qs: () => ({ ...qs }) } });
  return { space: draft.space, ...listPageOf(qs), order: listOrderOf(qs, 'createdAt') };
}

/** Parses the version listing request. Throws {@link InvalidColumnFilterError} on a bad field. */
export async function parseVersionList(
  qs: Record<string, unknown>,
): Promise<{ page: number; size: number; order: ListOrder }> {
  await applyCustomFilter(new VersionQueryDraft(), VersionFilter, {
    request: { qs: () => ({ ...qs }) },
  });
  return { ...listPageOf(qs), order: listOrderOf(qs, 'seq') };
}

export { InvalidColumnFilterError };
