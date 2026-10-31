# Deploy en Vercel

Cómo se despliega la web y qué hace cada pieza de `vercel.json`. Para las OG tags en
local (sin desplegar) ver [NGROK_SETUP.md](./NGROK_SETUP.md).

---

## 1. Build

```bash
npm run build      # el prebuild regenera el changelog traducido
```

Vercel ejecuta lo mismo (`npm run build`) y publica `dist/`.

---

## 2. Funciones serverless (`api/`)

| Función | Ruta pública | `maxDuration` | Para qué |
|---|---|---|---|
| `api/og-profile.js` | `/profile/:username` | 10 s | Inyecta OG tags con datos reales del perfil |
| `api/og-post.js` | `/post/:id` | 10 s | Inyecta OG tags de una publicación |
| `api/sitemap.xml.js` | `/sitemap.xml` | 15 s | Genera el sitemap |

Todas leen `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` del entorno (no del
cliente) y leen el `index.html` de `dist/` para inyectar las metaetiquetas antes de
servirlo. Cachean en memoria 5 minutos.

`/api/image-proxy` y `/api/music/*` **no** son funciones: `vercel.json` los reescribe
a los hosts propios (ver abajo), igual que `/cdn/*`.

Los handlers de música llevan `_` delante (`api/music/_stream.js`, …) a propósito:
con `_` Vercel no crea función en esa ruta y el rewrite llega al host propio. Si
añades un archivo sin `_` en `api/music/`, la función gana al rewrite.

---

## 3. Variables de entorno

En **Project Settings → Environment Variables**:

| Variable | Uso |
|---|---|
| `VITE_SUPABASE_URL` | Cliente y funciones (OG tags, sitemap) |
| `VITE_SUPABASE_ANON_KEY` | Cliente y funciones |
| `VITE_SITE_URL` | Opcional: base del sitemap (defecto `https://app.foranly.space`) |

Los `VITE_*` se insertan en el bundle en build time: si cambian, hay que redeployar.

---

## 4. `vercel.json`

**Headers** (todas las respuestas):

| Header | Valor |
|---|---|
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` |
| `Permissions-Policy` | `camera=(self), microphone=(self), geolocation=()` |

No hay header `Content-Security-Policy` HTTP a propósito: si existiera, el navegador
ignoraría la meta CSP que inyecta `plugins/cspPlugin.js` en el build y se perdería
toda la protección. El detalle está en
[../security/AUDITORIA-SEGURIDAD.md](../security/AUDITORIA-SEGURIDAD.md).

**Rewrites** (en este orden):

| Origen | Destino |
|---|---|
| `/sitemap.xml` | `/api/sitemap.xml` |
| `/profile/:username` | `/api/og-profile` |
| `/post/:id` | `/api/og-post` |
| `/api/image-proxy` | host propio del CDN (`mapi.foranly.space:24633`) |
| `/api/music/(.*)` | host propio de música (`mapi.foranly.space:24633`) |
| `/cdn/(.*)` | servidor CDN de archivos (`api.foranly.space:24587`) |
| `/(.*)` | `/index.html` (SPA, React Router) |

---

## 5. Importar el proyecto

1. [vercel.com/new](https://vercel.com/new) → importa el repositorio.
2. Framework preset **Vite**; build `npm run build`; output `dist`.
3. Añade las variables de entorno del punto 3.
4. Deploy.

---

## 6. Probar las OG tags

```bash
https://<tu-dominio>/profile/<usuario>
https://<tu-dominio>/post/<id>
```

Pégalas en Discord (o usa [opengraph.xyz](https://www.opengraph.xyz/)). Los crawlers
solo leen HTML, así que no hay CORS de por medio.

---

## 7. Troubleshooting

| Problema | Causa habitual |
|---|---|
| 404 en `/profile/:username` o `/post/:id` | Falta el rewrite correspondiente en `vercel.json` |
| Las OG tags salen genéricas | Variables de Supabase ausentes en Vercel, o el perfil no existe (cae al fallback) |
| El sitemap está vacío | `VITE_SUPABASE_URL` / `ANON_KEY` no llegan a la función |
| 504 en `/api/music/*` | El host propio de música no responde (ver [MUSIC_STREAMING.md](./MUSIC_STREAMING.md)) |
| Las imágenes del CDN no cargan | El host de `cdn-server` está caído (rewrite `/cdn/*`) |

---

## 8. Orden de despliegue de la app de escritorio

La app Electron carga la web publicada, así que **se despliega primero la web** y
después se publican los binarios. Ver
[ELECTRON_BUILD.md §6.1](./ELECTRON_BUILD.md#61-orden-de-despliegue-importante).
