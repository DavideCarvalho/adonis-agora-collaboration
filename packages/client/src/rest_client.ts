import { filterQuery, type OffsetPage } from '@adonis-agora/filter-client';
import type {
  CollabComment,
  CollabCommentListOptions,
  CollabListOptions,
  CollaborationClientConfig,
  CollabVersion,
  CollabVersionListOptions,
} from './types.js';

/**
 * Cliente REST mínimo pra rotas de colaboração geradas por
 * `node ace collaboration:init`. docName sempre por query/body —
 * nomes de documento contêm barras.
 */

export class CollabRestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Collaboration API respondeu ${status}: ${body}`);
    this.name = 'CollabRestError';
  }
}

/** Resolve a base URL: explicit, or the current origin when same-app. */
export function resolveBaseUrl(config: Pick<CollaborationClientConfig, 'baseUrl'>): string {
  if (config.baseUrl) return config.baseUrl.replace(/\/$/, '');
  const loc = (globalThis as { location?: { origin?: string } }).location;
  return loc?.origin ?? '';
}

function buildUrl(
  config: CollaborationClientConfig,
  path: string,
  params?: Record<string, string | undefined>,
  query?: string,
): string {
  const url = new URL(`${resolveBaseUrl(config)}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  if (query) {
    for (const [key, value] of new URLSearchParams(query)) url.searchParams.append(key, value);
  }
  return url.toString();
}

export async function collabFetch<T>(
  config: CollaborationClientConfig,
  path: string,
  init?: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    params?: Record<string, string | undefined>;
    /** An encoded query string appended after `params` (a `filterQuery().toQueryString()`). */
    query?: string;
    body?: unknown;
  },
): Promise<T> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const staticHeaders = (await config.getHeaders?.()) ?? {};

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...staticHeaders,
  };

  const requestInit: RequestInit = {
    method: init?.method ?? 'GET',
    headers,
  };
  if (init?.body !== undefined) {
    headers['content-type'] = 'application/json';
    requestInit.body = JSON.stringify(init.body);
  }

  const response = await fetchImpl(buildUrl(config, path, init?.params, init?.query), requestInit);

  if (!response.ok) {
    throw new CollabRestError(response.status, await response.text().catch(() => ''));
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/* ───────────────────────── endpoints tipados ───────────────────────── */

/** Default mount point of the collaboration routes — the server's default `routes.prefix`. */
export const DEFAULT_COLLAB_PREFIX = '/collaboration';

/** `config.prefix` (default {@link DEFAULT_COLLAB_PREFIX}) joined with `path`. */
function route(config: CollaborationClientConfig, path: string): string {
  const trimmed = (config.prefix ?? DEFAULT_COLLAB_PREFIX).replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? path : `/${trimmed}${path}`;
}

/**
 * The `@adonis-agora/filter` query string of a listing: `filter[space]`,
 * `sort`, `page`/`size` — each left out when not given.
 */
function listQuery(
  options: (CollabListOptions & { sort?: string | undefined }) | undefined,
  filters: Record<string, string | undefined> = {},
): string {
  const query = filterQuery();
  for (const [field, value] of Object.entries(filters)) {
    if (value !== undefined) query.where(field, value);
  }
  const sort = options?.sort;
  if (sort) {
    query.sort(sort.replace(/^-/, ''), sort.startsWith('-') ? 'desc' : 'asc');
  }
  let qs = query.toQueryString();
  // `page()` always sends both; send only what was given.
  const paging = new URLSearchParams();
  if (options?.page !== undefined) paging.set('page', String(options.page));
  if (options?.size !== undefined) paging.set('size', String(options.size));
  const extra = paging.toString();
  if (extra) qs = qs ? `${qs}&${extra}` : extra;
  return qs;
}

export function fetchToken(config: CollaborationClientConfig, docName: string) {
  return collabFetch<import('./types.js').CollabTokenInfo>(config, route(config, '/token'), {
    params: { doc: docName },
  });
}

/**
 * One page of a document's comments, as `{ data, meta }` — see
 * {@link CollabCommentListOptions} for the defaults.
 */
export function listComments(
  config: CollaborationClientConfig,
  docName: string,
  options?: CollabCommentListOptions,
) {
  return collabFetch<OffsetPage<CollabComment>>(config, route(config, '/comments'), {
    params: { doc: docName },
    query: listQuery(options, { space: options?.space }),
  });
}

/**
 * `userId` and `authorName` are not part of the input: the route stamps the
 * authenticated caller on the comment and ignores a body-supplied author.
 */
export function createComment(
  config: CollaborationClientConfig,
  input: Omit<
    import('./types.js').CollabComment,
    'id' | 'createdAt' | 'updatedAt' | 'resolvedAt' | 'userId' | 'authorName'
  >,
) {
  return collabFetch<import('./types.js').CollabComment>(config, route(config, '/comments'), {
    method: 'POST',
    body: input,
  });
}

export function resolveComment(
  config: CollaborationClientConfig,
  docName: string,
  commentId: string,
  resolved: boolean,
) {
  return collabFetch<import('./types.js').CollabComment | null>(
    config,
    route(config, `/comments/${encodeURIComponent(commentId)}`),
    { method: 'PATCH', params: { doc: docName }, body: { resolved } },
  );
}

export function deleteComment(
  config: CollaborationClientConfig,
  docName: string,
  commentId: string,
) {
  return collabFetch<{ deleted: boolean }>(
    config,
    route(config, `/comments/${encodeURIComponent(commentId)}`),
    { method: 'DELETE', params: { doc: docName } },
  );
}

/**
 * One page of a document's versions, as `{ data, meta }` — see
 * {@link CollabVersionListOptions} for the defaults.
 */
export function listVersions(
  config: CollaborationClientConfig,
  docName: string,
  options?: CollabVersionListOptions,
) {
  return collabFetch<OffsetPage<CollabVersion>>(config, route(config, '/versions'), {
    params: { doc: docName },
    query: listQuery(options),
  });
}

/**
 * The author is the authenticated caller: `handleCreateVersion` reads
 * `allowed.user.id` and never looks at the body, so a `userId` sent here went
 * nowhere while reading like it decided something.
 */
export function createVersion(
  config: CollaborationClientConfig,
  docName: string,
  label: string | null,
) {
  return collabFetch<import('./types.js').CollabVersion>(config, route(config, '/versions'), {
    method: 'POST',
    body: { docName, label },
  });
}

export function restoreVersion(
  config: CollaborationClientConfig,
  docName: string,
  versionId: string,
) {
  return collabFetch<void>(config, route(config, '/versions/restore'), {
    method: 'POST',
    body: { docName, versionId },
  });
}
