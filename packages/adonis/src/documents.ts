import type { CollabConnectionContext, CollaborationEngine, CollabPermission } from './types.js';

/**
 * Declaração declarativa de um documento colaborativo.
 *
 * Em vez de regex manual no authorize (o app repete
 * `new RegExp('^researches/([^/]+)/writing$')` por conexão), o app declara
 * padrões estruturados e a lib faz o match + extração de params.
 *
 * @example
 * // config/collaboration.ts
 * documents: {
 *   'researches/:id/writing': defineDocument<{ id: string }>({
 *     engine: 'yjs',
 *     async authorize(ctx, { docName, params }) {
 *       const research = await findAccessibleResearch(ctx.userId, params.id)
 *       return research
 *         ? { canRead: true, canWrite: true, canComment: true }
 *         : { canRead: false, canWrite: false, canComment: false }
 *     },
 *   }),
 * }
 */
export interface CollabDocumentDeclaration<
  P extends Record<string, string> = Record<string, string>,
> {
  /** Engine deste tipo de documento (default: o engine global). */
  engine?: CollaborationEngine;
  /**
   * Autorização deste documento. Recebe o docName resolvido e os segmentos
   * `:name` do padrão já extraídos — tipados via `defineDocument<Params>()`.
   * Omita para usar o authorize global.
   */
  authorize?: (
    ctx: CollabConnectionContext,
    info: { docName: string; params: P },
  ) => Promise<CollabPermission>;
}

export function defineDocument<P extends Record<string, string> = Record<string, string>>(
  declaration: CollabDocumentDeclaration<P>,
): CollabDocumentDeclaration<P> {
  return declaration;
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
