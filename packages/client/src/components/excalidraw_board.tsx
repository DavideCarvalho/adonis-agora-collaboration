import { useEffect, useMemo, useState, Suspense, lazy } from 'react';
import { CollaborationProvider, useCollabDoc } from '../index.js';
import { useExcalidrawSync } from '../hooks/use_excalidraw_sync.js';
import { YjsCollabDoc } from '../docs/index.js';

// CSS do Excalidraw — bundler (Vite) resolve para o pacote instalado no app.
import '@excalidraw/excalidraw/index.css';

const ExcalidrawLazy = lazy(async () => {
  const mod = await import('@excalidraw/excalidraw');
  return { default: mod.Excalidraw };
});

function BoardLoading() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-stone-50">
      <p className="text-sm text-muted-foreground">Carregando lousa…</p>
    </div>
  );
}

interface ExcalidrawBoardInnerProps {
  docName: string;
  readOnly?: boolean;
  langCode?: string;
}

function ExcalidrawBoardInner({
  docName,
  readOnly = false,
  langCode = 'pt-BR',
}: ExcalidrawBoardInnerProps) {
  const { doc } = useCollabDoc({ docName });
  const collabDoc = useMemo(() => (doc ? new YjsCollabDoc(doc) : null), [doc]);
  const [api, setApi] = useState<unknown>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useExcalidrawSync({ doc: collabDoc, excalidrawAPI: api as never, editorId: docName });

  if (!mounted || !collabDoc) return <BoardLoading />;

  return (
    <div className="relative h-full w-full overflow-hidden bg-stone-50">
      <Suspense fallback={<BoardLoading />}>
        <ExcalidrawLazy
          excalidrawAPI={setApi}
          langCode={langCode}
          viewModeEnabled={readOnly}
          initialData={{ appState: { viewBackgroundColor: '#fafaf9' } }}
        />
      </Suspense>
    </div>
  );
}

export interface ExcalidrawBoardProps {
  /** Nome do doc Yjs (ex.: `whiteboards/:id/canvas`). */
  docName: string;
  /** Modo somente leitura. */
  readOnly?: boolean;
  /** Código do idioma (default `'pt-BR'`). */
  langCode?: string;
  /** Base URL do servidor (ex.: `https://api.app`). */
  baseUrl: string;
  /** Retorna cabeçalhos de auth (ex.: `() => ({ cookie })`). */
  getHeaders: () => Record<string, string>;
}

/**
 * Componente pronto para edição colaborativa de lousa Excalidraw.
 *
 * Faz tudo: conecta ao doc Yjs, sincroniza desenho ↔ WebSocket, restaura
 * estado salvo ao recarregar.
 *
 * ```tsx
 * <ExcalidrawBoard
 *   docName="whiteboards/meu-id/canvas"
 *   baseUrl="https://api.app"
 *   getHeaders={() => ({ cookie: document.cookie })}
 * />
 * ```
 */
export function ExcalidrawBoard({
  docName,
  readOnly = false,
  langCode = 'pt-BR',
  baseUrl,
  getHeaders,
}: ExcalidrawBoardProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return <BoardLoading />;

  return (
    <CollaborationProvider baseUrl={baseUrl} getHeaders={getHeaders}>
      <ExcalidrawBoardInner docName={docName} readOnly={readOnly} langCode={langCode} />
    </CollaborationProvider>
  );
}