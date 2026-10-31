# Closedoor

Red social desarrollada con React y Supabase: perfiles, publicaciones multimedia,
interacciones sociales, contenido cifrado, encuestas, chat en tiempo real,
comunidades y música en el perfil. La misma base de código se sirve como **web**
(Vercel) y como **app de escritorio** (Electron), y comparte un **servidor CDN**
propio para los archivos subidos.

---

## Índice

1. [Tecnologías](#tecnologías)
2. [Estructura del proyecto](#estructura-del-proyecto)
3. [Requisitos](#requisitos)
4. [Instalación](#instalación)
5. [Variables de entorno](#variables-de-entorno)
6. [Scripts disponibles](#scripts-disponibles)
7. [Funcionalidades](#funcionalidades)
8. [Base de datos](#base-de-datos)
9. [Sistema de encriptación](#sistema-de-encriptación)
10. [Internacionalización](#internacionalización)
11. [Documentación](#documentación)
12. [Notas de desarrollo](#notas-de-desarrollo)

---

## Tecnologías

**Frontend**

- React 19 + React Router v7
- Vite 8 (bundler y servidor de desarrollo)
- React Icons, React Toastify

**Backend y servicios**

- Supabase: autenticación, PostgreSQL, Realtime y RPC
- Web Crypto API: encriptación AES-256-GCM
- Vercel Functions (`api/`) y `server.js` para desarrollo/self-hosted
- Servidor CDN propio en Go (`cdn-server/`) para almacenamiento de archivos
- Electron (`desktop/`) para la app de escritorio
- Innertube (YouTube) resuelto en el propio backend para el audio de la canción del perfil

**Herramientas de desarrollo**

- ESLint
- Babel con React Compiler

---

## Estructura del proyecto

```
Closedoor/
  index.html
  package.json
  vite.config.js
  eslint.config.js
  vercel.json              -- rewrites, headers y maxDuration de las funciones
  server.js                -- API local (dev / self-hosted) + streaming de música
  src/
    main.jsx               -- Punto de entrada
    App.jsx                -- Rutas y layout principal
    context/               -- Contextos (auth, notificaciones, llamadas, música...)
    hooks/                 -- Hooks (useAuth, usePageTitle...) y utilidades documentadas
    assets/
      Pages/               -- Páginas (Home, profile, Explore, Chat, Comunidades...)
      Resources/
        Components/        -- Componentes reutilizables (PostCard, Header, modales...)
        Styles/            -- Hojas de estilo
      services/            -- Servicios (Supabase, posts, usuarios, chat, i18n...)
        i18n/locales/      -- Traducciones (en, es, ja, pt, ru)
        migrations/        -- Migraciones SQL de Supabase
  api/                     -- Funciones serverless (OG tags, sitemap, música, imagen)
  desktop/                 -- App de escritorio (Electron) + servidor de música local
  plugins/                 -- Plugins de Vite (CSP, OG tags, API de música en dev...)
  scripts/                 -- Scripts de utilidad, tests y generación de assets
  cdn-server/              -- Servidor CDN de archivos (Go)
  public/                  -- Archivos estáticos
  docs/                    -- Documentación (índice en docs/README.md)
```

---

## Requisitos

- Node.js 18 o superior
- npm (también funciona con pnpm o yarn)
- Una cuenta en [Supabase](https://app.supabase.com)
- Opcional: Go 1.21+ para compilar el CDN y Wine/runner macOS para los instaladores
  de escritorio (ver [docs/deployment/ELECTRON_BUILD.md](./docs/deployment/ELECTRON_BUILD.md))

---

## Instalación

```bash
git clone https://github.com/Frantt21/Closedoor.git
cd Closedoor
npm install
```

1. Crea el archivo `.env.local` en la raíz (ver [Variables de entorno](#variables-de-entorno)).
2. Aplica las migraciones SQL en Supabase (ver [Base de datos](#base-de-datos)).
3. Arranca el servidor de desarrollo con `npm run dev` y abre `http://localhost:5173`.

---

## Variables de entorno

`.env.local` necesita al menos:

```
VITE_SUPABASE_URL=https://<proyecto>.supabase.co
VITE_SUPABASE_ANON_KEY=<clave_anon>
```

| Variable | Descripción |
|---|---|
| `VITE_SUPABASE_URL` | URL del proyecto de Supabase |
| `VITE_SUPABASE_DATA_API_URL` | URL alternativa del Data API |
| `VITE_SUPABASE_ANON_KEY` | Clave anónima/publicable de Supabase |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Nomenclatura alternativa de la clave pública |
| `VITE_SUPABASE_PUBLIC_KEY` | Nomenclatura alternativa de la clave pública |

---

## Scripts disponibles

| Comando | Descripción |
|---|---|
| `npm run dev` | Servidor de desarrollo con HMR (incluye la API de música local) |
| `npm run build` | Build de producción (el `prebuild` regenera el changelog traducido) |
| `npm run preview` | Vista previa de la build |
| `npm run start` | Servidor de producción (`server.js`: estáticos + API + música) |
| `npm run lint` | Análisis estático con ESLint |
| `npm run validate-locales` | Comprueba que los 5 idiomas tengan las mismas claves |
| `npm run translate-changelog` | Regenera el changelog traducido (`src/assets/data/changelog.js`) |
| `npm run music-api` | Levanta solo el servidor de música (`MUSIC_PORT` / `MUSIC_HOST`) |
| `npm run desktop:install` | Instala Electron y electron-builder dentro de `desktop/` (una vez) |
| `npm run desktop` | Abre la app de escritorio contra la web publicada |
| `FORANLY_WEB_URL=http://localhost:5173 npm run desktop` | La misma app apuntando al dev server |
| `npm --prefix desktop run build:linux` | Instaladores de Linux (también `build:win` y `build:mac`) en `desktop/dist/` |
| `npm run desktop:icons` | Regenera los iconos de la app desde `public/mini_icon.png` |

---

## Funcionalidades

### Autenticación y perfiles

- Registro e inicio de sesión (email o nombre de usuario) con CAPTCHA Turnstile
- Whitelist de proveedores de email en registro y login
- Perfil con avatar, banner, biografía, pronombres e intereses
- Color de acento y fondo de perfil personalizables
- Perfiles privados con solicitudes de seguimiento
- Actividad compartida desde la app de escritorio (canción, juego o programa abierto)

### Publicaciones

- Texto, imágenes (hasta 4), vídeos e incrustaciones (YouTube, Vimeo)
- Edición, eliminación y fijado (hasta 3)
- Programación para fecha futura y control de permisos de comentarios
- Likes, dislikes, comentarios anidados, reposts y guardados
- Menciones con `@` y hashtags con tendencias

### Encuestas

- Hasta 10 opciones, un voto por usuario y fecha de expiración opcional

### Contenido cifrado

- Ofuscación visual (codificación palindrómica) + encriptación AES-256-GCM
- Control de acceso por lista de usuarios permitidos

### Interacción social

- Seguidores, solicitudes para perfiles privados y bloqueos
- Notificaciones en tiempo real
- Chat con mensajes cifrados, reacciones, respuestas, llamadas (LiveKit) y canciones compartidas
- Comunidades

### Exploración

- Perfiles sugeridos, palabras y hashtags en tendencia, búsqueda de publicaciones

### Música

- Canción del perfil con metadatos (YouTube Music vía innertube, con iTunes como respaldo)
- Reproductor con cola, mini-reproductor y canciones compartidas en el chat
- Detalle de la resolución del audio: [docs/deployment/MUSIC_STREAMING.md](./docs/deployment/MUSIC_STREAMING.md)

---

## Base de datos

Las migraciones SQL están en `src/assets/services/migrations/` y deben aplicarse
**en orden numérico** desde el SQL Editor de Supabase.

La referencia completa (configuración, esquema, políticas RLS, funciones y triggers)
está en [docs/database/SUPABASE_REFERENCE.md](./docs/database/SUPABASE_REFERENCE.md).

### Tablas principales

| Tabla | Descripción |
|---|---|
| `profiles` | Perfiles de usuario y configuración de privacidad |
| `posts` | Publicaciones, metadatos de encriptación, encuestas y programación |
| `likes`, `dislikes`, `comments`, `comment_likes`, `reposts`, `saved_posts` | Interacciones |
| `follows` | Relaciones de seguimiento (`accepted`, `pending`) |
| `blocks` | Bloqueos entre usuarios |
| `notifications` | Notificaciones en tiempo real |
| `hashtags`, `post_hashtags` | Hashtags y tendencias |
| `poll_votes` | Votos de encuestas |
| `conversations`, `messages`, `chat_participants` | Chat |
| `communities`, `community_members` | Comunidades |

### Seguridad (RLS)

Todas las tablas usan Row Level Security, con grants explícitos por columna en
`profiles` (el email vive en `auth.users` y solo se lee vía RPC). En resumen:

- Los usuarios solo leen y modifican lo que les corresponde
- Los perfiles privados solo son visibles para seguidores aceptados
- Las publicaciones cifradas solo se leen con autorización
- Los usuarios bloqueados no ven contenido ni interactúan

Detalle de las vulnerabilidades encontradas y corregidas:
[docs/security/AUDITORIA-SEGURIDAD.md](./docs/security/AUDITORIA-SEGURIDAD.md).

---

## Sistema de encriptación

El sistema opera en dos capas:

1. **Ofuscación visual**: cada carácter se codifica como un palíndromo numérico
   (p. ej. `a` → `2112`).
2. **Encriptación real**: AES-256-GCM con la Web Crypto API. La clave se deriva con
   PBKDF2 (100 000 iteraciones, SHA-256) del **ID del autor** y del **conjunto
   ordenado de IDs de los usuarios permitidos**.

La clave no depende del ID de la publicación, lo que permite cifrar antes de crear
el registro. Documentación detallada:
[src/hooks/AlphabetEncryption.md](./src/hooks/AlphabetEncryption.md).

---

## Internacionalización

El sistema i18n vive en `src/assets/services/i18n/` y admite inglés (`en`), español
(`es`), japonés (`ja`), portugués (`pt`) y ruso (`ru`).

Para añadir un idioma:

1. Copia `src/assets/services/i18n/locales/en.json` a `<código>.json` y traduce.
2. Regístralo en `I18nContext.jsx`.
3. Verifica con `npm run validate-locales`.

---

## Documentación

| Tema | Documento |
|---|---|
| Índice general | [docs/README.md](./docs/README.md) |
| Base de datos y RLS | [docs/database/SUPABASE_REFERENCE.md](./docs/database/SUPABASE_REFERENCE.md) |
| Seguridad | [docs/security/AUDITORIA-SEGURIDAD.md](./docs/security/AUDITORIA-SEGURIDAD.md) |
| Pruebas de RLS | [docs/security/DB_SECURITY_TEST.md](./docs/security/DB_SECURITY_TEST.md) |
| Streaming de música | [docs/deployment/MUSIC_STREAMING.md](./docs/deployment/MUSIC_STREAMING.md) |
| App de escritorio | [desktop/README.md](./desktop/README.md) · [docs/deployment/ELECTRON_BUILD.md](./docs/deployment/ELECTRON_BUILD.md) |
| Deploy en Vercel | [docs/deployment/VERCEL_DEPLOYMENT.md](./docs/deployment/VERCEL_DEPLOYMENT.md) |
| OG tags en local (ngrok) | [docs/deployment/NGROK_SETUP.md](./docs/deployment/NGROK_SETUP.md) |
| Encriptación de publicaciones | [src/hooks/AlphabetEncryption.md](./src/hooks/AlphabetEncryption.md) |

---

## Notas de desarrollo

- **React Compiler**: el proyecto compila con `babel-plugin-react-compiler`, así que
  las optimizaciones de memorización son automáticas; evita añadir `useMemo`/`useCallback`
  manuales por sistema.
- **Cliente de Supabase**: normaliza la URL del proyecto y cifra la sesión con
  `secureStorage` (ver [docs/security/AUDITORIA-SEGURIDAD.md](./docs/security/AUDITORIA-SEGURIDAD.md)).
- **Caché local**: prefijos `fc_` con expiración por TTL.
- **Música**: el audio se resuelve con innertube en el backend del propio repo y se
  sirve como `/api/music/stream` same-origin. En el navegador YouTube solo entrega la
  pista completa a IPs con buena reputación, por lo que en producción el tráfico se
  envía a un host propio y, si aun así solo llega el preview, la app de escritorio
  (que resuelve el audio desde la IP del usuario) es el camino para oírla entera.
  Detalles y mediciones: [docs/deployment/MUSIC_STREAMING.md](./docs/deployment/MUSIC_STREAMING.md).
- **Tests de la resolución de streams** (offline, sin red):
  `node scripts/test-innertube-resolver.mjs`.
- **Tests de seguridad** (necesitan Supabase): `node scripts/test-security-full.mjs`
  (o `scripts/test-db-security.mjs` para el informe por tabla) y
  `npm run validate-locales` para las traducciones.
- **App de escritorio**: carga la web **publicada**, así que la web se despliega
  primero. Guía completa en [docs/deployment/ELECTRON_BUILD.md](./docs/deployment/ELECTRON_BUILD.md).
