# Documentación de Closedoor

Índice de la documentación del proyecto. La guía de instalación y uso general está
en el [README de la raíz](../README.md).

---

## Base de datos

| Documento | Descripción |
|---|---|
| [database/SUPABASE_REFERENCE.md](./database/SUPABASE_REFERENCE.md) | Referencia unificada: configuración, esquema de tablas, políticas RLS, funciones, triggers y realtime |
| [database/migracion-053-email.md](./database/migracion-053-email.md) | Nota sobre los grants por columna de `profiles` (migración 053) |

Las migraciones aplicables están en `src/assets/services/migrations/` y se ejecutan
en orden numérico.

## Seguridad

| Documento | Descripción |
|---|---|
| [security/AUDITORIA-SEGURIDAD.md](./security/AUDITORIA-SEGURIDAD.md) | Auditoría y endurecimiento: vulnerabilidades corregidas, CSP, RPCs, CI y modelo de permisos |
| [security/DB_SECURITY_TEST.md](./security/DB_SECURITY_TEST.md) | Pruebas manuales de RLS desde DevTools (lectura, escritura y modificación no autorizada) |

## Música

| Documento | Descripción |
|---|---|
| [deployment/MUSIC_STREAMING.md](./deployment/MUSIC_STREAMING.md) | Resolución del audio con innertube: límites del CDN de YouTube, presupuesto de tiempo en serverless, host propio y diagnóstico |
| [../desktop/README.md](../desktop/README.md) | App de escritorio: por qué existe y qué piezas están acopladas a ella |
| [deployment/ELECTRON_BUILD.md](./deployment/ELECTRON_BUILD.md) | Lanzar la app en desarrollo y generar/publicar los instaladores |

## Deploy y redes

| Documento | Descripción |
|---|---|
| [deployment/VERCEL_DEPLOYMENT.md](./deployment/VERCEL_DEPLOYMENT.md) | Deploy en Vercel: build, variables, OG tags y rewrites |
| [deployment/NGROK_SETUP.md](./deployment/NGROK_SETUP.md) | Probar las OG tags en local con un túnel ngrok |
| [deployment/ELECTRON_BUILD.md](./deployment/ELECTRON_BUILD.md) | Instaladores de escritorio (requisitos, firma, publicación) |

## Otros componentes

- [../src/hooks/AlphabetEncryption.md](../src/hooks/AlphabetEncryption.md) — encriptación de publicaciones (ofuscación visual + AES-256-GCM).

## Credenciales e infraestructura

Las credenciales del servidor CDN **no viven en el repositorio**: `INFRAESTRUCTURA.md`
se guarda **fuera de la carpeta del proyecto**. No lo copies dentro del repo, ni
siquiera de forma temporal.

La configuración **no secreta** del CDN (variables de entorno, validación JWT HS256/ES256,
rate limits, límites de subida) está documentada en los comentarios de
`cdn-server/main.go`.
