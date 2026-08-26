import type { CollaborationClientConfig } from './types.js';

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

function buildUrl(
  config: CollaborationClientConfig,
  path: string,
  params?: Record<string, string | undefined>,
): string {
  const base = config.baseUrl.replace(/\/$/, '');
  const url = new URL(`${base}${path}`);
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

export function fetchToken(config: CollaborationClientConfig, docName: string) {
  return collabFetch<import('./types.js').CollabTokenInfo>(config, '/collaboration/token', {
    params: { doc: docName },
  });
}

export function listComments(config: CollaborationClientConfig, docName: string, space?: string) {
  return collabFetch<import('./types.js').CollabComment[]>(config, '/collaboration/comments', {
    params: { doc: docName, space },
  });
}

export function createComment(
  config: CollaborationClientConfig,
  input: Omit<import('./types.js').CollabComment, 'id' | 'createdAt' | 'updatedAt' | 'resolvedAt'>,
) {
  return collabFetch<import('./types.js').CollabComment>(config, '/collaboration/comments', {
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
    `/collaboration/comments/${encodeURIComponent(commentId)}`,
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
    `/collaboration/comments/${encodeURIComponent(commentId)}`,
    { method: 'DELETE', params: { doc: docName } },
  );
}

export function listVersions(config: CollaborationClientConfig, docName: string) {
  return collabFetch<import('./types.js').CollabVersion[]>(config, '/collaboration/versions', {
    params: { doc: docName },
  });
}

export function createVersion(
  config: CollaborationClientConfig,
  docName: string,
  label: string | null,
  userId?: string | null,
) {
  return collabFetch<import('./types.js').CollabVersion>(config, '/collaboration/versions', {
    method: 'POST',
    body: { docName, label, userId },
  });
}

export function restoreVersion(
  config: CollaborationClientConfig,
  docName: string,
  versionId: string,
) {
  return collabFetch<void>(config, '/collaboration/versions/restore', {
    method: 'POST',
    body: { docName, versionId },
  });
}
