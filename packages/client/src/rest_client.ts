import type { CollabListOptions, CollaborationClientConfig } from './types.js';

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
): string {
  const url = new URL(`${resolveBaseUrl(config)}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

export async function collabFetch<T>(
  config: CollaborationClientConfig,
  path: string,
  init?: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    params?: Record<string, string | undefined>;
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

  const response = await fetchImpl(buildUrl(config, path, init?.params), requestInit);

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

/** `page`/`size`/`order` as query params, leaving out what was not given. */
function listParams(options: CollabListOptions | undefined): Record<string, string | undefined> {
  return {
    page: options?.page === undefined ? undefined : String(options.page),
    size: options?.size === undefined ? undefined : String(options.size),
    order: options?.order,
  };
}

export function fetchToken(config: CollaborationClientConfig, docName: string) {
  return collabFetch<import('./types.js').CollabTokenInfo>(config, route(config, '/token'), {
    params: { doc: docName },
  });
}

/** One page of a document's comments — see {@link CollabListOptions} for the defaults. */
export function listComments(
  config: CollaborationClientConfig,
  docName: string,
  space?: string,
  options?: CollabListOptions,
) {
  return collabFetch<import('./types.js').CollabComment[]>(config, route(config, '/comments'), {
    params: { doc: docName, space, ...listParams(options) },
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

/** One page of a document's versions — see {@link CollabListOptions} for the defaults. */
export function listVersions(
  config: CollaborationClientConfig,
  docName: string,
  options?: CollabListOptions,
) {
  return collabFetch<import('./types.js').CollabVersion[]>(config, route(config, '/versions'), {
    params: { doc: docName, ...listParams(options) },
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
