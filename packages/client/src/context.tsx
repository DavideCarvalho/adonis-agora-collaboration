import { type ReactNode, createContext, useContext, useMemo, useRef } from 'react';
import { DocSession } from './session.js';
import type { CollaborationClientConfig } from './types.js';

interface CollaborationContextValue {
  /** Sempre retorna o config mais recente do render atual. */
  getConfig(): CollaborationClientConfig;
  sessions: Map<string, DocSession>;
}

const CollaborationContext = createContext<CollaborationContextValue | null>(null);

export interface CollaborationProviderProps extends CollaborationClientConfig {
  children: ReactNode;
}

/**
 * Provider raiz. Uma sessão (Y.Doc + transporte) por docName — sobrevive a
 * unmount de componentes individuais e é destruída junto com o provider.
 *
 * ```tsx
 * <CollaborationProvider baseUrl="https://api.app" getHeaders={() => ({ cookie: ... })}>
 *   <Editor docName="researches/42/writing" />
 * </CollaborationProvider>
 * ```
 */
export function CollaborationProvider({ children, ...config }: CollaborationProviderProps) {
  const sessionsRef = useRef<Map<string, DocSession> | null>(null);
  if (sessionsRef.current === null) {
    sessionsRef.current = new Map<string, DocSession>();
  }

  const configRef = useRef<CollaborationClientConfig>(config);
  configRef.current = config;

  const value = useMemo<CollaborationContextValue>(
    () => ({
      getConfig: () => configRef.current,
      sessions: sessionsRef.current as Map<string, DocSession>,
    }),
    [],
  );

  return <CollaborationContext.Provider value={value}>{children}</CollaborationContext.Provider>;
}

/** Contexto interno — lança se usado fora do provider. */
export function useCollaborationContext(): CollaborationContextValue {
  const context = useContext(CollaborationContext);
  if (!context) {
    throw new Error('useCollabDoc/useAwareness exigem <CollaborationProvider> no tree');
  }
  return context;
}

/** Pega ou cria a sessão do documento (1 Y.Doc por docName). */
export function getOrCreateSession(
  context: CollaborationContextValue,
  docName: string,
): DocSession {
  let session = context.sessions.get(docName);
  if (!session) {
    session = new DocSession(docName, context.getConfig());
    context.sessions.set(docName, session);
  }
  return session;
}
