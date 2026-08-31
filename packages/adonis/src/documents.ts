import type { CollabConnectionContext, CollaborationEngine, CollabPermission } from './types.js';

/**
 * The `:name` segments of a document pattern, as the object
 * {@link matchDocumentPattern} produces at runtime — `'researches/:id/writing'`
 * gives `{ id: string }`, a pattern with no params gives `{}`.
 *
 * Mirrors the matcher exactly: the pattern is split on `/` and a segment is a
 * param only when it *starts* with `:`. A non-literal `string` pattern (the
 * runtime fallback) keeps the loose `Record<string, string>`.
 */
export type DocumentParams<Pattern extends string> = string extends Pattern
  ? Record<string, string>
  : { [Name in DocumentParamNames<Pattern>]: string };

type DocumentParamNames<Pattern extends string> = Pattern extends `${infer Head}/${infer Rest}`
  ? DocumentParamNames<Head> | DocumentParamNames<Rest>
  : Pattern extends `:${infer Name}`
    ? Name
    : never;

/**
 * Declaração declarativa de um documento colaborativo.
 *
 * Em vez de regex manual no authorize (o app repete
 * `new RegExp('^researches/([^/]+)/writing$')` por conexão), o app declara
 * padrões estruturados e a lib faz o match + extração de params.
 *
 * Os `params` do `authorize` são inferidos **da chave** do pattern por
 * `defineConfig` (via {@link DocumentParams}) — nenhum type parameter é
 * necessário, e um `params.id` num pattern `whiteboards/:boardId` é erro de
 * compilação.
 *
 * @example
 * // config/collaboration.ts
 * documents: {
 *   'researches/:id/writing': {
 *     engine: 'yjs',
 *     async authorize(ctx, { docName, params }) {
 *       const research = await findAccessibleResearch(ctx.userId, params.id)
 *       return research
 *         ? { canRead: true, canWrite: true, canComment: true }
 *         : { canRead: false, canWrite: false, canComment: false }
 *     },
 *   },
 * }
 */
export interface CollabDocumentDeclaration<
  P extends Record<string, string> = Record<string, string>,
> {
  /** Engine deste tipo de documento (default: o engine global). */
  engine?: CollaborationEngine;
  /**
   * Autorização deste documento. Recebe o docName resolvido e os segmentos
   * `:name` do padrão já extraídos — tipados a partir da chave do pattern
   * quando o documento é declarado dentro de `defineConfig`.
   * Omita para usar o authorize global.
   */
  authorize?: (
    ctx: CollabConnectionContext,
    info: { docName: string; params: P },
  ) => Promise<CollabPermission>;
}

/**
 * Identity helper for declaring a document **outside** `config/collaboration.ts`
 * (a shared module, a test). Inside `defineConfig({ documents })` it is
 * redundant — the params are already inferred from the key, and a plain object
 * literal is the documented form.
 *
 * `P` is inferred from the context when there is one (a `documents` entry), so
 * the explicit `defineDocument<{ id: string }>()` form is only needed when the
 * declaration lives away from its pattern. Passing a `P` that contradicts the
 * pattern it is later attached to is a compile error at the config.
 */
export function defineDocument<P extends Record<string, string> = Record<string, string>>(
  declaration: CollabDocumentDeclaration<P>,
): CollabDocumentDeclaration<P> {
  return declaration;
}

/** The pattern {@link defineCollection} declares for a prefix. */
export type CollectionPattern<Prefix extends string> = `${Prefix}/:id`;

/**
 * Declares a **collection**: many documents named `<prefix>/<id>` that share
 * one engine and one rule — the shape almost every document type has.
 *
 * A pattern only matches many documents when it has a `:segment`; a bare
 * `'whiteboards'` matches exactly one document named `whiteboards`. This
 * helper makes the common case impossible to get wrong: give it the prefix
 * and it declares `'<prefix>/:id'`, with `params.id` typed in `authorize`.
 * Spread it into `documents`:
 *
 * @example
 * documents: {
 *   ...defineCollection('whiteboards', {
 *     engine: 'automerge',
 *     async authorize(ctx, { params }) {
 *       const member = await Whiteboard.isMember(params.id, ctx.userId)
 *       return { canRead: member, canWrite: member, canComment: member }
 *     },
 *   }),
 *   ...defineCollection('announcements'), // engine + authorize from the globals
 * }
 *
 * The prefix is the literal part of the name: no `:params`, no leading or
 * trailing slash. Nested literals are fine (`'workspaces/main/boards'`). For a
 * shape that is not `<prefix>/<id>` — several params, a suffix like
 * `researches/:id/writing` — write the pattern out as a key instead.
 */
export function defineCollection<Prefix extends string>(
  prefix: Prefix,
  declaration: CollabDocumentDeclaration<{ id: string }> = {},
): { [K in CollectionPattern<Prefix>]: CollabDocumentDeclaration<{ id: string }> } {
  if (
    prefix === '' ||
    prefix.includes(':') ||
    prefix.startsWith('/') ||
    prefix.endsWith('/') ||
    prefix.includes('//')
  ) {
    throw new Error(
      `[@adonis-agora/collaboration] defineCollection(${JSON.stringify(prefix)}): the prefix is ` +
        'the literal part of the document name — no ":params", no leading or trailing "/". ' +
        'defineCollection("whiteboards") declares "whiteboards/:id".',
    );
  }
  return { [`${prefix}/:id`]: declaration } as {
    [K in CollectionPattern<Prefix>]: CollabDocumentDeclaration<{ id: string }>;
  };
}

/**
 * The `:name` segments of a pattern, in order — `[]` for a pattern that
 * matches exactly one document.
 */
export function documentPatternParams(pattern: string): string[] {
  return pattern
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1));
}

/**
 * Casa um docName com um padrão `researches/:id/writing`, extraindo os
 * params nomeados. Retorna null se não casar.
 */
export function matchDocumentPattern(
  pattern: string,
  docName: string,
): Record<string, string> | null {
  const parts = pattern.split('/');
  const actual = docName.split('/');
  if (parts.length !== actual.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part.startsWith(':')) {
      params[part.slice(1)] = actual[index]!;
    } else if (part !== actual[index]) {
      return null;
    }
  }
  return params;
}
