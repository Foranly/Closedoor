# Streaming de música (innertube)

Cómo se resuelve y se sirve el audio de la canción del perfil y del reproductor.
Todo el pipeline vive en el repo: **no hay servidor externo ni binarios**
(yt-dlp/ffmpeg), solo `fetch`.

```
cliente ──► /api/music/ytsearch   metadatos (YouTube Music; iTunes/Deezer de respaldo)
   │
   └─────► /api/music/stream?...&prewarm=1   resuelve la pista (innertube)
           /api/music/stream?artist=…&title=… sirve el audio (proxy con Range)
                        │
                        ▼
           api/_innertube.js  ──►  CDN de YouTube
```

Los handlers (`api/music/_resolve.js`, `_stream.js`, `_health.js`, `_ytsearch.js`)
son **los mismos** en Vercel, en `npm run dev` (montados por
`plugins/musicDevApiPlugin.js`), en `npm start` y en la app de escritorio
(`scripts/music-api-server.mjs`).

---

## 1. Metadatos

- **Búsqueda**: `/api/music/ytsearch` usa YouTube Music vía innertube y filtra
  subidas de UGC, podcasts y colecciones; solo devuelve canciones y vídeos
  musicales del catálogo.
- **Respaldo**: si no responde o no da resultados, iTunes (directo) o Deezer vía
  `/api/music-search`.
- **Preview de 30 s**: los resultados de YouTube no lo traen. Al fijar o enviar la
  canción se pide uno a iTunes (`withPreviewFallback` en `musicService.js`) para
  que el reproductor tenga algo que sonar mientras se resuelve el audio completo.

---

## 2. Límites medidos del CDN de YouTube

Las URLs **audio-only** (adaptive: `140`, `599`, …) llevan `rqh=1` y el CDN solo
entrega un tramo que:

- empieza siempre en el offset 0,
- tiene un tamaño **variable** (medido 0,3–1 MiB según IP y momento),
- no se recarga reutilizando la misma URL,
- y devuelve `403` si se pide un offset ≥ 1 MiB, aunque sea la primera petición.

Además, el `<audio>` de Chrome pide la continuación (`Range: bytes=1048576-`) **en
paralelo** al arrancar, así que un 403 ahí tumba el pipeline entero (medido con
navegador real: `PIPELINE_ERROR_READ` a los ~1,5 s, con 64 s ya en buffer).

Cómo se sortea:

1. El proxy pide siempre bloques **acotados** de 1 MiB (`upstreamRangeHeader`).
2. El resolver prefiere el mejor audio-only cuya pista **entera** quepa en ese
   tramo (`140` → `139` → `599`).
3. Si ninguno cabe, o si el CDN responde 403 al primer bloque, se sirve el formato
   **muxed itag 18** (`pickMuxedFormat` + `markStreamFallback`): verificado contra el
   CDN que sus URLs sirven **cualquier** offset (3, 5 y 12 MB de un archivo de
   13 MB) mientras las audio-only daban 403.
4. Solo si la pista no tiene muxed con URL se devuelve `playable: false` y la card
   cae al preview de 30 s.

Coste del muxed: descarga también el vídeo (3–13 MB por canción) y el audio es AAC
a ~128 kbps; el audio-only, cuando entra, pesa menos pero suena peor (32–50 kbps).
La idea viene del proyecto **Scrup** (ytdownloader): el audio-only va *gated*, el
muxed no. Levantar el tope del audio-only exigiría un **PO token** (servicio
extra, p. ej. `bgutil-ytdlp-pot-provider`).

---

## 3. Presupuesto de tiempo en serverless

En Vercel no se puede asumir que el resolver tiene todo el tiempo del mundo.
Síntoma de no hacerlo: `[music] stream health check failed: signal timed out`,
`504` en `/api/music/stream` y la card cayendo al preview.

- `resolveTrackAudio` trabaja con **presupuesto** (`RESOLVE_BUDGET_MS` = 25 s) y
  cada paso tiene timeout de 7 s (`REQUEST_TIMEOUT_MS`), así el handler responde su
  propio 504 legible (`isResolveTimeout`) en segundos en vez de morir con el 504
  opaco de la plataforma. El audio del CDN se pide con 12 s (`AUDIO_TIMEOUT_MS`).
- El pre-warm al montar la card **no** se puerta detrás de `/api/music/health`: una
  instancia fría lo saltaba justo en la primera reproducción.
- El `<audio>` **reintenta una vez** la misma URL (`&r=N`, el backend lo ignora)
  antes de caer al preview.
- `vercel.json` declara `maxDuration` para las funciones, además del
  `export const config` de cada una.
- El pre-warm se pide a **`/api/music/stream?...&prewarm=1`**, la misma función que
  sirve el audio: en Vercel cada archivo de `api/` es una función distinta con
  memoria propia, así que calentar desde `/api/music/resolve` no comparte caché.

---

## 4. Producción actual: host propio

Las funciones de Vercel de este proyecto solo responden si **no se modifican**: los
5 handlers antiguos funcionan, pero cualquier función nueva o editada se cuelga
(comprobado con funciones triviales sin imports: `maxDuration` se respeta pero el
handler nunca corre).

Peor aún: **una función gana al rewrite**. Medido en producción, con el rewrite de
música ya desplegado, `/api/music/health` seguía colgado 12 s mientras
`/api/music/nonexistent` lo servía el host propio en 0,3–0,5 s. Por eso los
handlers llevan `_` delante: con `_` Vercel no crea función en esa ruta, no hay
colisión y `/api/music/(.*)` llega al host.

`vercel.json` reescribe el tráfico, igual que hace con `/cdn/*` y
`/api/image-proxy`:

```json
{ "source": "/api/music/(.*)", "destination": "http://mapi.foranly.space:24633/api/music/$1" }
```

El cliente no cambia (mismas URLs, mismo origen). Al no ser una función no hay tope
de reloj, así que desaparecen los 504 por tiempo; a cambio, el audio depende de que
ese host esté encendido.

### Qué hay que subir a ese host

Nueve archivos, ~76 KB, sin `node_modules` (el árbol de música no importa ningún
paquete npm) y sin variables de entorno:

- `music-server.js` — puente de una línea en la raíz
- `scripts/music-api-server.mjs` — el servidor real (`npm run music-api`)
- `api/_musicHttp.js`, `api/_music.js`, `api/_innertube.js`
- `api/music/{_health,_resolve,_stream,_ytsearch}.js`

Conservando las rutas relativas (el `_` solo importa en Vercel) y con un
`package.json` que declare `"type": "module"`, porque los `.js` de `api/` son ESM.
Requiere Node 18+ (`fetch` global y `Readable.fromWeb`).

### Puerto

`MUSIC_PORT` / `MUSIC_HOST`; si no hay ninguno usa `SERVER_PORT`, el puerto que
Pterodactyl ya asigna al contenedor. Sin eso el proceso se queda en 5990 y la URL
pública del panel da `connection refused`.

### Arrancarlo con `node`, no con `ts-node`

El panel de Pterodactyl usa `node` solo si el MAIN FILE termina en `.js`; si no,
cae en `ts-node --esm`. Este proyecto es JS puro (sin `typescript` ni
`tsconfig.json`) y `ts-node@10.9.2` revienta al leer su config
(`TypeError: Cannot read properties of undefined (reading 'fileExists')`) porque
npm le instala como peer `typescript@7`, que ya no expone `ts.sys`. Reproducido en
limpio incluso con un archivo de una línea. La salida si el panel obliga a ts-node
es fijar el compilador viejo: `npm i -D typescript@5`.

---

## 5. Diagnóstico

```bash
# ¿el host responde y puede resolver?
curl -s http://127.0.0.1:5990/api/music/health
# {"ok":true,"stream":"innertube",...}

# ¿la pista completa es servible desde esta IP?
curl -s "http://127.0.0.1:5990/api/music/resolve?artist=Feid&title=Ferxxo%20100&duration=168"
# {"success":true,...,"playable":true,...}
```

En producción, lo mismo contra el dominio:

```bash
curl 'https://app.foranly.space/api/music/stream?artist=…&title=…&prewarm=1'
```

Responde el formato resuelto si alcanza YouTube, o un 504 JSON en segundos con el
motivo.

Test offline del resolver (sin red): `node scripts/test-innertube-resolver.mjs`.

---

## 6. Navegador vs app de escritorio

YouTube solo entrega el stream completo a conexiones con buena reputación. Desde un
datacenter (Vercel, un VPS) la resolución termina en *"Sign in to confirm you're not
a bot"* y los PO tokens no lo arreglan. En el navegador, por tanto, la card puede
caer al preview de 30 s y se ofrece la app de escritorio
(`src/assets/Resources/Components/DesktopAppPrompt.jsx`), que resuelve el audio
desde la IP del usuario. Ver [desktop/README.md](../../desktop/README.md).
