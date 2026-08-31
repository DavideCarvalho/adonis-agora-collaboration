import { lazy, Suspense, useEffect, useState } from 'react';
import { useExcalidrawSync } from '../hooks/use_excalidraw_sync.js';
import { CollaborationProvider, useCollabDoc } from '../index.js';

// O CSS do Excalidraw precisa ser importado pelo APP HOST, não por esta
// lib — bundlers (Vite, rolldown) não conseguem resolver o subpath
// './index.css' no campo `exports` do `@excalidraw/excalidraw` quando
// o import vem de um `node_modules` aninhado (peer dep), e forçar
// o import aqui quebra a build com `Package subpath './index.css' is
// not defined`. O app que usa o `ExcalidrawBoard` deve importar
// `@excalidraw/excalidraw/index.css` direto no entrypoint (e.g. na
// `whiteboard_canvas.tsx` ou na página de lousa).

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
  const { collabDoc } = useCollabDoc({ docName });
  const [api, setApi] = useState<unknown>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useExcalidrawSync({ doc: collabDoc, excalidrawAPI: api as never, editorId: docName });

  if (!mounted) return <BoardLoading />;

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
  /** Base URL do servidor (ex.: `https://api.app`). Default: `location.origin`. */
  baseUrl?: string | undefined;
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
