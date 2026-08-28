---
'@adonis-agora/collaboration-client': minor
---

**feat: `useExcalidrawSync` hook + `ExcalidrawBoard` component**

Nova integração oficial entre o collaboration-client e o Excalidraw, sem depender
de pacotes de terceiros (`y-excalidraw`).

- `useExcalidrawSync({ doc, excalidrawAPI })` — liga a API imperativa do
  Excalidraw a um `CollabDoc` (Yjs). Desenho local → Y.Map.set; mudança remota
  → updateScene; montagem → restaura estado salvo.
- `ExcalidrawBoard({ docName, baseUrl, getHeaders })` — componente pronto, já
  com `CollaborationProvider`, lazy load, CSS, pt-BR.

Uso:

```tsx
import { ExcalidrawBoard } from '@adonis-agora/collaboration-client'

<ExcalidrawBoard
  docName="whiteboards/meu-id/canvas"
  baseUrl="https://api.app"
  getHeaders={() => ({ cookie: document.cookie })}
/>
```

Ou com hook separado:

```tsx
const [api, setApi] = useState(null)
const { doc } = useCollabDoc({ docName })
useExcalidrawSync({ doc, excalidrawAPI: api })
<Excalidraw excalidrawAPI={setApi} />
```