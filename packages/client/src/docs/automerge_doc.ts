import type { CollabDoc } from './types.js';

/**
 * Implementação Automerge do contrato CollabDoc — envolve um documento
 * Automerge (`A.Doc`) lendo/escrevendo chaves top-level. A sync de rede
 * (WS + merge) é administrada pelo host.
 */
export interface AutomergeDocHost<T extends Record<string, unknown>> {
  /** Doc atual (null antes do primeiro payload do server). */
  readDoc(): T | null;
  /** Aplica uma mutação sobre o doc atual via A.change. */
  change(updater: (doc: T) => void): void;
  /** Assina mudanças locais/remotas; retorna unsubscribe. */
  onChange(callback: () => void): () => void;
}

export class AutomergeCollabDoc<T extends Record<string, unknown>> implements CollabDoc {
  constructor(private readonly host: AutomergeDocHost<T>) {}

  read<U>(key: string): U | undefined {
    const doc = this.host.readDoc();
    return doc ? (doc[key] as U) : undefined;
  }

  write(key: string, value: unknown): void {
    this.host.change((doc) => {
      (doc as Record<string, unknown>)[key] = value;
    });
  }

  onUpdate(callback: () => void): () => void {
    return this.host.onChange(callback);
  }
}
