# Auditoría y Endurecimiento de Seguridad — Closedoor

**Estado:** la suite de auditoría exige **100%**. Se ejecuta a mano antes de publicar
(cualquier fallo sale con exit 1).
**Migraciones de seguridad:** 053, 054, 055, 056, 057, 058, 059, 060, 069, 071, 074

---

## Resumen ejecutivo

Auditoría de seguridad integral (DB + cliente + servidor): se corrigieron
**3 vulnerabilidades reales** y varios puntos débiles. La suite
(`scripts/test-security-full.mjs`) cubre hoy todas las áreas por debajo.

| Área | Estado |
|---|---|
| DB (RLS, columnas, RPCs, tablas sociales) | cubierta |
| SQL Injection (API REST) | cubierta |
| XSS (helpers reales) | cubierta |
| Auth (validaciones, whitelist de email) | cubierta |
| Cache (storage cifrado) | cubierta |
| Web (CSP, headers, superficie XSS) | cubierta |

---

## Vulnerabilidades corregidas (reales)

### 1. Emails visibles en la tabla `profiles` (crítica)

**Problema:** Cualquiera con la anon key podía hacer `SELECT id, email, username FROM profiles`
y ver **todos los emails** de la base. RLS trabaja a nivel de *fila*, no de *columna*, así que
la política no protegía el email.

**Solución (migración 053 v2, `src/assets/services/migrations/053_revoke_email_column.sql`):**
- `REVOKE ALL ON public.profiles FROM anon, authenticated` — elimina cualquier grant previo
 (el REVOKE de columna simple de la v1 no surtió efecto en Supabase).
- Grants explícitos **por columna** con lo que la app necesita:
 - `SELECT`: las 52 columnas públicas (**sin email**)
 - `INSERT`: `id, email, username, displayname, created_at` (email solo **escribible** al registrarse)
 - `UPDATE`: las 52 columnas públicas (sin email)
 - `DELETE`: tabla completa (RLS controla filas)
- El email solo se LEE vía **RPCs `SECURITY DEFINER`** (login por username y check de registro):
 - `get_email_by_username(uname)` `text`
 - `email_exists(addr)` `boolean`
 - Corren con permisos del definer, `SET search_path = public`, devuelven solo `text|boolean`,
 nunca la tabla completa.

**Verificación directa (anon key, sin sesión):**

| Consulta | Antes | Después |
|---|---|---|
| `select=email` | 200 devolvía el email | **401 permission denied** |
| `select=id,email,username` | 200 devolvía todo | **401 permission denied** |
| `select=id,username,avatar_url` | 200 | 200 (app intacta) |

**Frontend (`userService.js`, `AuthContext.jsx`):**
- `getEmailByUsername` y `checkEmailExists` ahora usan las RPCs.
- `getUserProfile`, `refreshProfile`, `createUserProfile` selects explícitos con
 `PROFILE_PUBLIC_COLUMNS` (52 columnas reales, sin email). Se corrigió de paso
 `profile_card_visibility` `badges_visibility` y se añadieron columnas que faltaban.

---

### 2. Token de sesión en la URL (OAuth con Discord)

**Problema:** supabase-js usa `flowType: 'implicit'` por defecto durante el login con Discord,
el `access_token` y `refresh_token` viajaban en el **hash de la URL** (`#access_token=...`),
quedando en el historial del navegador y pudiendo filtrarse por `Referrer`.

**Solución:**
- `src/assets/services/supabaseclient.js` `auth.flowType: 'pkce'`.
 Con PKCE en la URL solo va un `code` de un solo uso; el token se intercambia en segundo plano.
- `src/assets/Pages/AuthCallback.jsx` corrección defensiva: si `exchangeCodeForSession` falla
 (code ya consumido por el auto-exchange de supabase-js), ahora **re-consulta la sesión** antes
 de mostrar error — evita un falso "Login failed" tras un login exitoso.
- El login con password no se ve afectado.

---

### 3. Header CSP HTTP anulaba la meta CSP (regresión detectada en review)

**Problema:** `vercel.json` enviaba `Content-Security-Policy: frame-ancestors 'none'` como header
HTTP. Según la spec CSP, **si existe un header CSP, el navegador IGNORA la meta CSP** del HTML
(que lleva la política completa: script-src, connect-src, object-src, etc.). ¡Era una regresión
que desactivaba toda la protección XSS!

**Solución:** Eliminado el header CSP de `vercel.json` y de `server.js`.
`X-Frame-Options: DENY` ya cubre el clickjacking. La meta CSP (inyectada por
`plugins/cspPlugin.js` solo en build) sigue siendo la única fuente de la política.

---

## Endurecimiento aplicado

### 4. CSP estricta (defensa contra XSS)

**`plugins/cspPlugin.js`** (nuevo) — inyecta la meta CSP **solo en build de producción**
(`apply: 'build'`), sin romper el dev server con HMR:

| Directiva | Configuración |
|---|---|
| `script-src` | `'self'` + `https://challenges.cloudflare.com` — **sin `unsafe-inline` ni `unsafe-eval`** |
| `connect-src` | Supabase (REST + Realtime `wss://`), iTunes, Klipy, Turnstile, LiveKit (`*.livekit.cloud`). La canción del perfil y las búsquedas van por rutas **same-origin** (`/api/music/stream`, `/api/music-search`), así que `'self'` las cubre: **sin hosts de túnel** (el music server yt-dlp se eliminó) |
| `style-src` | `'self'` + `'unsafe-inline'` (obligatorio: inlineCssPlugin + estilos inline de React) |
| `frame-src` | Turnstile + YouTube + Vimeo |
| `worker-src` `'self'` · `object-src 'none'` · `base-uri 'self'` · `form-action 'self'` | — |

### 5. `window.__supabase` restringido a DEV

En `src/assets/services/supabaseclient.js` el global solo se expone con `import.meta.env.DEV`.
En producción ya no existe un global que un script inyectado pudiera usar para leer la sesión.

### 6. Cache de LinkPreview cifrado

`src/assets/Resources/Components/LinkPreview.jsx` — el cache de OG tags (`og_cache_*`) pasó de
`sessionStorage` crudo a `getSessionItem`/`setSessionItem` de `secureStorage` (cifrado + key
hasheada), consistente con el resto del storage.

### 7. Headers de seguridad en `server.js` y `vercel.json`

La app **no usa cookies** (la sesión vive en localStorage cifrado vía el adapter), así que los
flags `Secure`/`SameSite` no aplican. Se añadió el resto del hardening:

| Header | server.js | vercel.json |
|---|---|---|
| `X-Frame-Options: DENY` | | |
| `X-Content-Type-Options: nosniff` | | |
| `Referrer-Policy: strict-origin-when-cross-origin` | | |
| `Strict-Transport-Security` | (solo HTTPS) | `max-age=31536000; includeSubDomains; preload` |
| `Permissions-Policy` | — | `camera=(self), microphone=(self), notifications=(self), geolocation=(), interest-cohort=()` |
| Header CSP HTTP | (a propósito) | (a propósito) |

`Permissions-Policy` permite micrófono/cámara/notificaciones para `self` porque LiveKit captura
audio desde el documento principal (no desde un iframe). Geolocalización y FLoC bloqueados.

### 8. `sanitizeContent` mejorado (`helpers.js`)

Ahora **vacía por completo** los atributos `href`/`src`/`action`/`formaction` con protocolos
peligrosos, y el orden de pasos garantiza que el vaciado ocurra antes de la neutralización en
texto plano:

```
<a href="javascript:alert(1)">click</a>    <a href="">click</a>
<script>alert(1)</script>                   ""  (bloque completo eliminado)
<img src=x onerror=alert(1)>                <img src=x>
```

---

### 9. RPCs blindados contra anon (migración 054 — auditoría en vivo)

**Problema (detectado atacando `app.foranly.space` con la anon key, sin sesión):**

| RPC | Vulnerabilidad | Evidencia |
|---|---|---|
| `bump_hashtag_usage` | `SECURITY DEFINER` sin `REVOKE` Supabase da `EXECUTE PUBLIC` por defecto. Cualquiera **creaba hashtags** y podía inflar el trending infinitamente | `bump('audtest_xxx')` creó el hashtag real en la DB (`use_count:1`) |
| `unfollow_both_ways` | Idem: sin sesión, conociendo dos UUIDs **des-seguía a cualquier par de usuarios** | Respuesta `204` sin sesión |
| `get_email_by_username` | `SECURITY DEFINER` con `GRANT` a `anon` — **fuga de emails** por enumeración de usernames | `get_email_by_username('orlndku')` email real sin sesión |

**Solución (`src/assets/services/migrations/054_secure_rpcs.sql`):**
- `bump_hashtag_usage` `REVOKE PUBLIC` + exige `auth.uid()` (solo usuarios logueados crean posts con hashtags).
- `unfollow_both_ways` `REVOKE PUBLIC` + exige `auth.uid() = blocker_id` (solo el que bloquea des-followea).
- `get_email_by_username` `REVOKE` de `anon`, solo `authenticated`. **El login por username deja de funcionar para anon** (trade-off aceptado para matar el scraping de emails).
- Frontend: `AuthContext.login` pasó a solo email con el placeholder "Email" en los 5 idiomas.

> **Actualización (migración 074):** `get_email_by_username` fue **eliminado** (la columna
> `profiles.email` ya no existe desde 069). El login por username se recuperó con
> `login_email_by_username(uname, pwd)`, que solo devuelve el email si la contraseña es
> correcta. Ver sección 14.

**El test de seguridad ahora EXIGE estos bloqueos** (checks `1d`, `1d2`, `1d3`): si la migración no está aplicada, la auditoría baja de 100%.

### 10. Tablas de interacción social sin RLS (auditoría en vivo — migración 055)

**Problema (detectado atacando `app.foranly.space` con la anon key, sin sesión):**

| Tabla | Vulnerabilidad | Evidencia |
|---|---|---|
| `likes` | **Sin RLS habilitado** 10+ filas con user_ids + post_ids | 200 con datos reales |
| `comments` | **Sin RLS habilitado** user_id, content, post_id, image_url | 200 con contenido completo |
| `follows` | **Sin RLS habilitado** follower_id, following_id, status | 200 con grafo social |
| `reposts` | Solo INSERT policy, **sin SELECT restriction** | 200 con user_ids |
| `dislikes` | Policy "Anyone can read" user_ids expuestos | 200 con datos |
| `comment_likes` | Policy "Anyone can view" user_ids expuestos | 200 con datos |
| `comment_dislikes` | Policy "Anyone can view" user_ids expuestos | 200 con datos |
| `posts_public` | Incluía `allowed_users` en la vista | Columna visible |
| `posts` (raw) | SELECT accesible con anon (debería ser solo la vista) | 25 columnas |
| `profiles` (raw) | SELECT accesible con anon (debería ser solo la vista) | Accesible |

**Solución (`src/assets/services/migrations/055_hardening_table_access.sql`):**
- `likes` Enable RLS + SELECT solo `authenticated` (oculta grafo social de anon)
- `comments` Enable RLS + SELECT público (contenido visible), escritura solo `authenticated`
- `follows` Enable RLS + SELECT solo los involucrados (`follower_id = auth.uid() OR following_id = auth.uid()`)
- `reposts` SELECT solo `authenticated`
- `dislikes`, `comment_likes`, `comment_dislikes` SELECT solo `authenticated`
- `posts_public` `allowed_users` eliminado de la vista
- `REVOKE SELECT` en `posts` y `profiles` (raw tables) acceso solo a través de las vistas

**El test de seguridad ahora EXIGE estos bloqueos** (checks `1f`–`1p`): si la migración no está aplicada, 8 checks fallan y la auditoría baja de 100%.

---

### 11. Hardening de funciones SQL (migración 058 — Supabase Advisor)

**Problema:** Supabase Advisor reportó **65 warnings** en 3 categorías:

| Warning | Cantidad | Riesgo |
|---|---|---|
| `function_search_path_mutable` | 21 funciones | Search path poisoning |
| `anon_security_definer_function_executable` | 20 funciones | Anon puede bypassear RLS via SECURITY DEFINER |
| `authenticated_security_definer_function_executable` | 20 funciones | Usuarios pueden llamar funciones que solo deberían ser triggers |
| `rls_policy_always_true` | 2 policies | INSERT sin restricción en chat |
| `auth_leaked_password_protection` | 1 | Contraseñas comprometidas no se bloquean |

**Solución (`src/assets/services/migrations/058_fix_advisor_warnings.sql`):**

| Acción | Funciones | Elimina |
|---|---|---|
| `SET search_path = public` | 21 funciones | `function_search_path_mutable` |
| `REVOKE EXECUTE FROM anon` + role check `auth.uid() IS NULL` | 8 funciones críticas | `anon_security_definer` |
| `REVOKE EXECUTE FROM anon, authenticated` en triggers | 17 funciones (notify_*, increment/decrement, handle_*) | Ambos warnings |
| Documentar `WITH CHECK (true)` en chat | `chat_participants`, `conversations` | Info (intencional) |

**Funciones protegidas con role check interno (defensa en profundidad):**
- `bump_hashtag_usage` `IF auth.uid() IS NULL THEN RAISE EXCEPTION`
- `unfollow_both_ways` role check + `auth.uid() = blocker_id`
- `increment_post_views` role check
- `get_email_by_username` role check
- `get_encrypted_post` role check
- `create_mention_notification` role check
- `cleanup_post_hashtags` role check
- `can_repost_post` role check

**Pendiente (configuración manual en Dashboard):**
- Habilitar **Leaked Password Protection** en Supabase Auth Password Settings "Check against HaveIBeenPwned"

---

### 12. Login valida dominio del email (hardenamiento de login)

**Cambio:** el login ahora valida **formato Y dominio** del email (mismo que el registro).
Cualquier intento de login con un dominio fuera de la whitelist (`user@tempmail.com`,
`user@random.com`, etc.) es rechazado con el error `auth.email_domain_not_allowed`.

**Archivos modificados:**
- `Login.jsx` — agrega check de `validateEmail() === 'domain'`
- `AuthContext.jsx` — agrega check de dominio en la función `login()`
- `test-security-full.mjs` — check negativo invertido (ahora espera validación de dominio)

---

### 13. Whitelist de proveedores de email (registro y login)

**Problema:** como la verificación de email está deshabilitada en Supabase, cualquiera podía
crear una cuenta con un correo falso/desechable (`user@tempmail.com`, dominios inventados, etc.).

**Solución (nuevo módulo puro `src/assets/services/emailValidation.js`):**
- Whitelist de proveedores principales + variantes regionales:
 - **Google:** `gmail.com`, `googlemail.com`
 - **Microsoft:** `outlook.com` (+ `.es`, `.com.ar`, `.com.br`, `.com.mx`), `hotmail.com`
 (+ `.es`, `.com.br`, `.co.uk`, `.fr`), `live.com` (+ `.com.ar`, `.com.br`, `.com.mx`)
 - **Yahoo:** `yahoo.com` (+ `.com.ar`, `.com.mx`, `.com.es`, `.com.br`, `.co.uk`, `.ca`, `.co.in`)
 - **Proton:** `proton.me`, `protonmail.com`
 - **Apple:** `icloud.com`, `me.com`
- `validateEmail(email)` `'invalid'` (formato) | `'domain'` (fuera de whitelist) | `null` (válido)
- Case-insensitive, tolera espacios al inicio/fin y plus-addressing (`user+tag@gmail.com`).
- Módulo **puro sin imports** el test de CI lo importa directamente (mismo motivo que helpers.js).
 `userService.js` re-exporta todo para que la app no cambie de API.

**Aplicación:**
- **Registro (`Register.jsx` + `AuthContext.register`):** bloquea formato inválido Y dominio fuera
 de la whitelist — evita cuentas basura nuevas.
- **Login (`Login.jsx` + `AuthContext.login`):** valida **formato Y dominio** (mismo que el registro).
- Mensajes localizados en los 5 idiomas (`auth.email_invalid`, `auth.email_domain_not_allowed`).

---

### 14. Login por username sin filtrar emails (migración 074)

**Problema:** tras 060 el login por username estaba deshabilitado, y tras 069
(`DROP COLUMN profiles.email`) los RPCs `get_email_by_username` y `email_exists`
seguían apuntando a una columna inexistente (siempre devolvían NULL/false).

**Solución (`src/assets/services/migrations/074_username_login.sql`):**
- Se **elimina** `get_email_by_username(uname)`: devolvía el email con solo conocer
 el username (enumeración/scraping).
- Se crea `login_email_by_username(uname, pwd)` `SECURITY DEFINER`:
 - Cruza `profiles.username` con `auth.users` (el email real vive ahí).
 - Devuelve el email **solo si** `crypt(pwd, encrypted_password) = encrypted_password`
 (bcrypt vía pgcrypto).
 - Contraseña incorrecta, username inexistente o throttle → `NULL` (misma respuesta).
 - Throttle por `(username, IP)` usando `request.headers` de PostgREST: 8 fallos en
 15 min bloquean temporalmente el par. Evita fuerza bruta directa al RPC, que no
 pasa por el CAPTCHA de GoTrue.
- `email_exists(addr)` se reescribe contra `auth.users` y sigue devolviendo solo `boolean`.

**Frontend:**
- `userService.loginEmailByUsername(username, password)` llama al nuevo RPC.
- `AuthContext.login` resuelve el username vía RPC y luego `signInWithPassword`
 (GoTrue revalida la contraseña y el CAPTCHA). Error genérico
 "Incorrect username or password" (no distingue username inexistente de clave mala).
- Placeholder de login: "Email or username" en los 5 idiomas.

---

## El test de seguridad

**`scripts/test-security-full.mjs`** — auditoría completa. Ejecutar con:

```bash
node scripts/test-security-full.mjs
```

**Mejora clave:** la sección XSS ahora importa y ejecuta las **funciones REALES de producción**
(`sanitizeContent`, `sanitizeUrl` de `helpers.js`) en vez de un simulador local que divergía.
Esto eliminó los últimos 2 falsos positivos.

### Qué prueba cada sección

- **DB:** RLS en perfiles/posts/conversaciones/notificaciones/mensajes/votos/llamadas,
 email oculto y revocado, RPCs disponibles, UPDATE/DELETE/INSERT de entidades ajenas bloqueados.
 Incluye el check autenticado de la migración 085: insertar en `messages` un
 `shared_post_id` de un perfil privado ajeno debe devolver `42501` (RLS); si
 devuelve `23503` la fila pasó la política y solo falló la FK de conversación.
- **SQL:** payloads de inyección contra la API REST (parámetros `eq`).
- **XSS:** sanitización real de contenido y URLs (script, eventos, iframe, svg, protocolos).
- **AUTH:** password, username, y email con la **whitelist real** (`validateEmail` de
 `emailValidation.js`): dominios permitidos (incl. variantes regionales), case-insensitive,
 plus-addressing, y bloqueo de dominios basura (tempmail, inventados).
- **CACHE:** secureStorage usa XOR + salt + hash de keys + wrap key no extraíble en IDB.
- **WEB:** CSP en build (sin unsafe-eval/inline), cobertura de túneles/LiveKit/Realtime,
 headers (sin header CSP HTTP), RPCs, `__supabase` solo DEV, y check negativo de que el
 login NO bloquea por dominio (cuentas legacy).

### Resultado final

```
DB: 100%   SQL: 100%   XSS: 100%
AUTH: 100%   CACHE: 100%   WEB: 100%

 TOTAL: 100%
 TODAS LAS PRUEBAS PASARON
```

Los conteos por área cambian al añadir checks: lo que importa es que el total sea
100% y que el script salga con exit 0.

---

## Ejecutar la auditoría antes de publicar

El repositorio **no tiene CI de seguridad**: el único workflow es el de release de
escritorio. La auditoría se corre a mano:

```bash
node scripts/test-security-full.mjs     # DB/RLS, XSS, auth, cache, CSP
npm run validate-locales                # traducciones
npx vite build                          # build + meta CSP
```

`scripts/test-security-full.mjs` **sale con exit 1 si hay CUALQUIER fallo** y acepta
credenciales desde `process.env` (con fallback a `.env.local`), así que puede
ejecutarse en cualquier CI o cron sin tocar el código:

```bash
VITE_SUPABASE_URL=https://xxxx.supabase.co \
VITE_SUPABASE_ANON_KEY=<anon> \
node scripts/test-security-full.mjs
```

Los checks que necesitan sesión (hoy solo el de la migración 085) usan una cuenta
normal de prueba, nunca la `service_role`; sin ella se imprimen como `⏭️ omitido`
y no cuentan ni como pass ni como fail:

```bash
SEC_TEST_EMAIL=cuenta-de-prueba@dominio.com \
SEC_TEST_PASSWORD=<password> \
node scripts/test-security-full.mjs
```

> Con credenciales del proyecto real el script consulta la DB de producción: úsalo
> desde una red de confianza y nunca con la `service_role` key.

---

## Modelo de seguridad resultante

**Cliente** (`secureStorage.js` + `supabaseclient.js`)

- Master key de 32 B por CSPRNG, **solo en memoria**; envuelta con AES-GCM en una
  `CryptoKey` no extraíble de IndexedDB.
- Cada entrada de `localStorage`/`sessionStorage`: `SHA-256(masterKey ‖ salt)` + XOR.
- La sesión se cifra y se descifra solo en memoria; OAuth con PKCE (el token nunca
  viaja en la URL).
- Limitaciones aceptadas (documentadas en `secureStorage.js`): un XSS activo del
  mismo origen puede llamar a las APIs de descifrado; si se borra IndexedDB hay que
  re-loguearse una vez.

**Red**

- Headers de seguridad en `server.js` y `vercel.json`, y **ningún** header CSP HTTP
  (la meta CSP inyectada en build es la única política).
- Meta CSP generada por `plugins/cspPlugin.js` solo en build.

**Base de datos**

- `profiles`: grants por columna y sin `email` (vive en `auth.users`, solo se lee vía
  RPC).
- Vistas `profiles_public` / `posts_public` para el acceso anónimo; tablas crudas
  revocadas.
- RLS en todas las tablas sociales; RPCs `SECURITY DEFINER` con `search_path` fijo,
  `REVOKE` de `anon` y role check interno.

**Validación de entrada**

- Registro: password ≥ 6 caracteres, username 3-20 `[a-zA-Z0-9_]`, email en whitelist
  y CAPTCHA Turnstile.
- Login: email o username; el username pasa por un RPC con contraseña y throttle.
- Contenido: `sanitizeContent` / `sanitizeUrl`; la API REST de Supabase parametriza
  las consultas, así que los payloads de inyección no devuelven filas.

**CI**

- Sin CI en el repo: la suite y el build se ejecutan a mano antes de publicar
  (`node scripts/test-security-full.mjs` + `npx vite build`).

### Tabla resumen: Qué puede hacer cada rol

| Acción | Anon | Authenticated | Protegido por |
|---|---|---|---|
| Ver perfil público | | | Vista `profiles_public` |
| Ver posts públicos | | | Vista `posts_public` |
| Ver comentarios | | | RLS público en SELECT |
| Ver emails | | | REVOKE columna + RPC |
| Ver likes/follows/reposts | | (propios) | REVOKE + RLS |
| Ver posts encriptados | | (si está en allowed_users) | RLS |
| Ver conversaciones | | (si es participante) | RLS |
| Ver notificaciones | | (propias) | RLS |
| Crear/editar/borrar posts | | (propios) | RLS |
| Crear likes/comments | | | RLS |
| Des-followear otros | | | Role check: `uid = blocker_id` |
| Inflar trending | | | REVOKE + role check |
| Inflar vistas | | | REVOKE + role check |
| Habilitar RLS | | | REVOKE |
| Login con email basura | | | Whitelist de proveedores |
| Login por username | (solo con password correcta) | (solo con password correcta) | RPC password-gated + throttle (074) |
| Registro con email basura | | | Whitelist de proveedores |

---

## Archivos tocados (completo)

| Archivo | Cambio |
|---|---|
| `migrations/053_revoke_email_column.sql` | REVOKE ALL + grants por columna + RPCs |
| `migrations/054_secure_rpcs.sql` | REVOKE de anon en RPCs críticas |
| `migrations/055_hardening_table_access.sql` | RLS en tablas sociales, fix vistas |
| `migrations/056_fix_rls_likes_reposts_follows.sql` | REVOKE explícito + FORCE RLS |
| `migrations/057_restore_view_access.sql` | Restaura GRANT en vistas |
| `migrations/058_fix_advisor_warnings.sql` | SET search_path, role checks, REVOKE triggers |
| `migrations/059_fix_remaining_advisor_warnings.sql` | REVOKE post-CREATE OR REPLACE |
| `migrations/060_close_final_gaps.sql` | REVOKE get_email_by_username + rls_auto_enable de authenticated |
| `migrations/074_username_login.sql` | Login por username password-gated: elimina `get_email_by_username`, crea `login_email_by_username` + throttle, y reescribe `email_exists` contra `auth.users` |
| `emailValidation.js` | Whitelist de proveedores de email |
| `userService.js` | RPCs para email, PROFILE_PUBLIC_COLUMNS |
| `AuthContext.jsx` | waitForKeyReady, validación de email |
| `Register.jsx` | Bloquea email fuera de whitelist |
| `Login.jsx` | Valida formato Y dominio del email |
| `api/_innertube.js` | Resolución de streams con la API innertube (sustituye al music server yt-dlp) |
| `api/music/_stream.js` | Proxy same-origin del audio (reenvía Range, nunca expone la URL firmada). El `_` evita que Vercel lo convierta en función: una función en esa ruta gana al rewrite y nunca llega al host propio |
| `supabaseclient.js` | pkce, __supabase solo DEV, storage cifrado |
| `AuthCallback.jsx` | waitForKeyReady + re-consulta sesión |
| `LinkPreview.jsx` | Cache cifrado |
| `helpers.js` | sanitizeContent mejorado |
| `postService.js` | Eliminado allowed_users de SELECTs |
| `cspPlugin.js` | Meta CSP en build |
| `vercel.json` | HSTS, Permissions-Policy |
| `server.js` | Security headers |
| `test-security-full.mjs` | Helpers reales en XSS, exit code para CI |

---

## Para producción

1. Migraciones 053-060 aplicadas en Supabase
2. Habilitar **Leaked Password Protection** en Supabase Auth Password Settings
3. Redeploy en Vercel (headers + CSP)
4. `node scripts/test-security-full.mjs` en 100% antes de cada deploy
5. No hay nada que configurar para la música: el audio se resuelve con innertube
   dentro de la app (`api/_innertube.js`, servido por `/api/music/stream`)
6. Re-ejecutar `node scripts/test-security-full.mjs` tras cualquier cambio
