# Cifrado E2E del chat (diseño)

Diseño del cifrado de extremo a extremo para los mensajes de chat: clave aleatoria
por conversación, envuelta por dispositivo con ECDH, privadas en IndexedDB.

> **Estado:** diseño, no implementado. El chat actual usa `encryptForUsers` /
> `decryptForUser` (`src/assets/services/alphabetEncryption.js`), cuya clave se
> deriva de UUID públicos y por tanto **no es E2E**.
> Ver [AUDITORIA-SEGURIDAD.md](./AUDITORIA-SEGURIDAD.md) para el modelo general.

---

## 1. Objetivo y modelo de amenaza

**Objetivo.** Que ni la base de datos, ni el CDN, ni quien obtenga un dump o una
`service_role` key puedan leer el contenido de un chat, las imágenes adjuntas ni
la clave que los protege.

**Protege contra**

- Dump, backup o réplica de Postgres; acceso de operadores/insiders.
- Fuga de la `service_role` key o de un JWT de usuario.
- Robo del almacenamiento del servidor (CDN incluido).
- Lectura de `messages`, `conversations` o `conversation_keys` desde el dashboard.

**No protege contra**

- Servidor malicioso que sirva JavaScript alterado (no hay clientes firmados).
- XSS activo en el propio origen durante la sesión: puede usar las claves ya
  descifradas en memoria. Ningún esquema cliente lo evita.
- Endpoint comprometido (malware, extensión con permisos de página).
- MITM si el usuario **no compara la huella** del dispositivo de la otra persona.
- Metadatos: quién habla con quién, cuándo, tamaño de los mensajes, reacciones,
  posts/comunidades compartidas, tokens de invitación.

**No hay Double Ratchet.** Es una clave estática por conversación con epochs de
rotación. No hay forward secrecy por mensaje ni post-compromiso automática; se
mitiga con rotación (sección 5).

---

## 2. Punto de partida (lo que hay hoy)

| Pieza | Situación |
|---|---|
| `messages.ciphertext` / `iv` / `encrypted_for` | AES-256-GCM con clave **derivada** de `senderId + IDs ordenados` (PBKDF2 100k, salt fijo) |
| `conversations.last_message_text` | Guarda el preview **en claro** (texto o URL de imagen) |
| Imágenes del chat | Subidas al CDN **sin cifrar**, URL pública dentro del mensaje |
| `chat_participants` | Solo conversaciones 1:1 (no hay flujo de grupos hoy) |
| `secureStorage.js` | Ya usa IndexedDB + `CryptoKey` no exportable: patrón a reutilizar |
| Migraciones | Última `081`; se aplican a mano en el editor SQL de Supabase |

Consecuencia: hoy un dump permite descifrar todo el historial. Este diseño cambia
**de dónde sale la clave**, no el algoritmo.

---

## 3. Decisiones criptográficas

| Decisión | Elección | Motivo |
|---|---|---|
| Cifrado de contenido | AES-256-GCM (AEAD) | Ya disponible en WebCrypto, rápido, autenticado |
| IV | 12 bytes aleatorios por mensaje/archivo | Nunca reutilizar IV con la misma clave |
| Clave de conversación | 32 bytes de `crypto.getRandomValues` | No derivable de datos públicos |
| Intercambio | ECDH **P-256** + HKDF-SHA256 | WebCrypto en todos los navegadores y Electron; X25519 aún no es universal en WebCrypto |
| Envoltura | ECIES: clave **efímera** por destinatario, AES-256-GCM | Cualquier miembro puede envolver para un dispositivo usando solo su clave pública |
| Contexto | `additionalData` (AAD) en mensaje y en la envoltura | Impide trasplantar ciphertext entre conversaciones o epochs |
| Identidad de dispositivo | Par ECDH P-256 por dispositivo, privada **no exportable** | Robar IndexedDB no permite exportar la clave |
| Verificación | Huella SHA-256 de la clave pública (bloques de 5 dígitos) + TOFU | Sin verificación out-of-band queda un MITM posible; hay que hacerlo explícito |

**Nada de PBKDF2 en v2.** La clave ya es aleatoria: se elimina la derivación de
~40-80 ms por conversación del esquema actual.

### Detalle de la envoltura (ECIES)

```
efímera   = ECDH P-256 (par nuevo por cada wrap)
secreto   = ECDH(efímera.privada, dispositivo_destino.pública)      // 32 B
wrapKey   = HKDF-SHA256(secreto, salt = convId|epoch, info = "closedoor-wrap-v1")
wrapped   = AES-256-GCM(wrapKey, iv_aleatorio, claveConversacion,
                        aad = convId|epoch|deviceIdDestino)
```

Se publica `{ recipient_device_id, ephemeral_pub, iv, wrapped_key }`. El receptor
recalcula el secreto con su privada y desenvuelve. El emisor no necesita clave de
identidad propia para envolver: solo la pública del destinatario.

### Clave exportable solo durante la entrega

`crypto.subtle.wrapKey` exige que la clave envuelta sea exportable. Por tanto:

1. se genera la clave de conversación con `extractable: true`;
2. se envuelve para cada dispositivo;
3. se exporta a `raw`, se **re-importa con `extractable: false`** y se guarda esa
   copia en IndexedDB; el handle exportable se descarta.

Lo persistido nunca es exportable. Al desenvolver se usa `unwrapKey(..., false, …)`,
que devuelve directamente una `CryptoKey` no exportable.

---

## 4. Identidad de dispositivo

Cada **dispositivo** (cada perfil de navegador, cada instalación de Electron) tiene
su propio par de claves. Web y escritorio son dispositivos distintos, y eso es
correcto: cada uno recibe su propia copia de la clave.

```js
// ECDH P-256, privada no exportable (la pública siempre es exportable por spec)
const pair = await crypto.subtle.generateKey(
  { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']
);
const pubJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
```

`deviceId = crypto.randomUUID()` se genera en el cliente y se guarda junto al par
en IndexedDB. El registro en el servidor contiene **solo** la clave pública:

```sql
create table if not exists public.e2e_devices (
  id           uuid primary key,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  pub_jwk      jsonb not null,
  label        text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz
);
```

- `select`: cualquier usuario autenticado ve dispositivos **no revocados** (las
  públicas son públicas; hacen falta para envolver).
- `insert` / `update` / `delete`: solo `user_id = auth.uid()`.
- Revocar = `revoked_at = now()`; el cliente borra sus claves locales y los
  demás dejan de envolver para ese dispositivo.

**Aprobación de dispositivos (obligatoria).** Un servidor comprometido podría
insertar un dispositivo suyo a nombre de la víctima con `service_role`; si los
clientes envolvieran automáticamente para cualquier dispositivo listado, leería
todo. Por eso:

1. Un dispositivo nuevo aparece como `pending` (local, sin fila o con
   `created_at` reciente y `label` provisional).
2. Para recibir claves necesita aprobación de **otro dispositivo del mismo
   usuario** (o, si no existe, de la otra persona de la conversación).
3. La aprobación compara la huella de 60 dígitos del dispositivo nuevo.
4. Solo se envuelve para dispositivos aprobados/pinados.

La primera vez que se ve el dispositivo de otra persona se fija su huella (TOFU)
y se muestra en el perfil de la conversación; si cambia, aviso visible y bloqueo
de la envoltura automática hasta confirmar.

---

## 5. Claves de conversación

```sql
create table if not exists public.conversation_keys (
  conversation_id     uuid not null references public.conversations(id) on delete cascade,
  epoch               int  not null,
  recipient_user_id   uuid not null references public.profiles(id) on delete cascade,
  recipient_device_id uuid not null references public.e2e_devices(id) on delete cascade,
  ephemeral_pub       jsonb not null,
  iv                  text not null,
  wrapped_key         text not null,
  created_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  primary key (conversation_id, epoch, recipient_device_id)
);
```

- `select`: participantes de la conversación (los blobs envueltos son inútiles sin
  la privada del dispositivo, y así cada cliente detecta wraps que faltan).
- `insert`: participante, `recipient_user_id` debe ser participante y el
  dispositivo debe seguir **activo** (`is_active_e2e_device`). Así la revocación
  corta la entrega en el servidor aunque haya clientes sin actualizar.
- Sin `update` / `delete` (se van con el `cascade`).

**Creación.** Al crear la conversación (`getOrCreateConversation`), el cliente que
la crea genera `epoch = 1` con clave aleatoria y envuelve para sus dispositivos
aprobados y para los de la otra persona. Si el otro no tiene ningún dispositivo
publicado, la conversación queda **pendiente de clave** hasta que lo publique.

**Relleno de huecos (rewrap).** Cualquier miembro con la clave, al abrir la
conversación, compara los dispositivos activos de los participantes con las filas
de `conversation_keys` del epoch actual y envuelve las que falten (si el
dispositivo está aprobado). Cubre: primer dispositivo del par, dispositivo nuevo
aprobado, y limpieza tras revocaciones.

**Rotación de epoch.** Nueva clave aleatoria + envoltura para todos los
dispositivos activos, `epoch++`. Se rota cuando:

- se revoca un dispositivo;
- cambia el conjunto de participantes (cuando existan grupos);
- el usuario pulsa "Rotar clave" en la conversación.

Los mensajes antiguos siguen ligados a su epoch; no se re-cifran.

**Clave sin envoltura disponible.** Si el usuario abre la conversación y no tiene
fila para su dispositivo, la UI muestra "Esperando clave" y los mensajes v2 como
`🔒`. No hay descifrado parcial ni fallback silencioso a v1.

---

## 6. Formato del mensaje

### v2

Reutiliza `ciphertext` / `iv` (base64) y añade tres columnas:

```sql
alter table public.messages add column if not exists enc_v smallint not null default 1;
alter table public.messages add column if not exists key_epoch int;
alter table public.messages add column if not exists sender_device_id uuid
  references public.e2e_devices(id) on delete set null;
```

El `id` del mensaje se genera en el cliente (`crypto.randomUUID()`), porque forma
parte del AAD:

```
aad = `${conversation_id}|${sender_id}|${msg_id}|${key_epoch}`
```

El payload es JSON y va **dentro** del ciphertext:

```json
{ "v": 2, "t": "text", "body": "hola", "replyTo": null, "song": null }
```

Así los metadatos futuros (adjuntos, enlaces, miniaturas) no necesitan columnas
nuevas. `encrypted_for` se sigue rellenando con los participantes para no romper
el filtro de Realtime ni el cliente viejo; en v2 no autoriza nada (autoriza tener
la clave).

### Compatibilidad y downgrade

- `enc_v = 1` → ruta actual (`decryptForUser`), intacta.
- `enc_v = 2` → clave de `conversation_keys` por `key_epoch`.
- Un cliente viejo no puede leer v2, así que **el envío se decide por
  capacidades**: si el otro participante no tiene ningún dispositivo publicado
  (o no ha actualizado), se envía v1 y la UI lo marca como "sin cifrado E2E".
- Riesgo aceptado y visible: un servidor malicioso podría ocultar los
  dispositivos del par para forzar v1 (downgrade). Mitigación: indicador por
  conversación, pin de huellas y no volver a v1 una vez que la conversación usó
  v2, salvo acción manual.

### Imágenes

Misma clave de conversación, IV propio por archivo:

```json
{ "v": 2, "t": "img", "id": "<id-cdn>", "iv": "<b64>", "mime": "image/webp",
  "w": 1440, "h": 1080, "bytes": 183402 }
```

El CDN debe aceptar **blobs opacos** (sin sniff de magic bytes ni ffmpeg) y
servirlos como `application/octet-stream`; el `<img>` se construye con un
`Blob` descifrado en memoria y `URL.createObjectURL` (la CSP ya permite `blob:`
en `img-src`). Sin miniaturas en servidor. Este cambio vive en `cdn-server/`,
que no está en el repositorio.

---

## 7. Almacenamiento en el cliente (IndexedDB)

Base `closedoor-e2e`, versión 1:

| Store | Clave | Contenido |
|---|---|---|
| `identity` | `userId` | `{ deviceId, publicJwk, privateKey: CryptoKey (ECDH, no exportable), createdAt }` |
| `convKeys` | `${conversationId}:${epoch}` | `{ conversationId, epoch, key: CryptoKey (AES-GCM, no exportable), addedAt }` |
| `pins` | `${userId}:${deviceId}` | `{ fingerprint, firstSeenAt, verified }` |

- Las `CryptoKey` se guardan por *structured clone*; al ser `extractable: false`
  no se pueden exportar ni con acceso completo a IndexedDB.
- `secureStorage.js` ya demuestra el patrón (clave maestra envuelta + IDB) y su
  limitación aceptada: si se borran los datos del sitio, la clave se pierde.
- No se guarda nada de esto en `localStorage`.
- `clearDecryptedCache()` (logout) vacía el cache en memoria, **no** IndexedDB:
  las claves son del dispositivo y hacen falta al volver a entrar.
- Acción explícita "Olvidar claves de este dispositivo" (ajustes de seguridad)
  borra `identity` + `convKeys` + `pins` y revoca el dispositivo en el servidor.

---

## 8. Flujos

**Abrir sesión.** `AuthContext` → `ensureDevice()`: lee o crea identidad, publica
la pública si no existe. Antes de cargar el chat: `prepareConversation(convId)`
→ lee `conversation_keys` del epoch máximo, desenvuelve lo que sea del
dispositivo actual, cachea las claves en memoria.

**Enviar.** `getConversationKey(convId)` (epoch actual) → cifra payload con IV
aleatorio y AAD → inserta con `id` propio, `enc_v = 2`, `key_epoch`,
`sender_device_id`. Actualiza `conversations.last_message_text` con un marcador
(`🔒`, `🔒 Imagen`, `🎵`), nunca con contenido.

**Recibir.** Realtime / `getMessages` entregan ciphertext. `decryptV2(msg)`:
valida `enc_v`, busca clave por `key_epoch`, descifra, parsea JSON. Sin clave →
placeholder, sin error visible repetido.

**Dispositivo nuevo.** Se registra y publica su pública. La UI muestra un código
de 60 dígitos. En otro dispositivo del mismo usuario, "Aprobar dispositivo" →
envuelve todas las claves que tenga localmente para esa pública. Sin otro
dispositivo, el historial no es recuperable (es el coste de no tener escrow).

**Miembro nuevo (futuro grupo).** Quien lo invita envuelve la clave actual para
sus dispositivos aprobados. No se re-cifra el historial: no lee lo anterior.

**Revocación.** `revoked_at` → los clientes dejan de envolver para él y rotan
epoch. Un dispositivo revocado no puede leer mensajes nuevos aunque tenga la
clave vieja.

---

## 9. Esquema SQL (migración `082_e2e_chat.sql`)

Incluye: `e2e_devices`, `conversation_keys`, las tres columnas de `messages`,
`enable row level security` en las dos tablas nuevas y las políticas descritas.
Reutiliza `public.is_conversation_participant(conv_id)` (032) y añade dos helpers
`SECURITY DEFINER`: `is_conversation_user(conv, user)` para la política de
escritura y `is_active_e2e_device(device, user)` para no envolver claves a
dispositivos revocados. También un trigger que impide cambiar la clave pública
de un dispositivo o reactivar uno revocado.

Puntos a respetar:

- Idempotente (`if not exists`, `drop policy if exists`), como el resto.
- Ejecutar **antes** de desplegar el cliente v2.
- El cliente debe degradar si las tablas no existen todavía (`42P01` /
  `PGRST205`): detectar una vez y seguir en v1.
- `messages.id` debe seguir aceptando UUID del cliente (hoy solo tiene
  `default gen_random_uuid()`; no hay trigger que lo sobrescriba).
- Añadir un índice por `(recipient_device_id)` para el rewrap.

---

## 10. Cambios por archivo

| Archivo | Cambio |
|---|---|
| `src/assets/services/e2e/idb.js` | Abrir/crear `closedoor-e2e` (nuevo) |
| `src/assets/services/e2e/device.js` | Generar identidad, publicar, huella, aprobación (nuevo) |
| `src/assets/services/e2e/keys.js` | Wrap/unwrap, epoch, rewrap, cache de claves (nuevo) |
| `src/assets/services/e2e/message.js` | `encryptV2` / `decryptV2`, AAD, helpers de bytes (nuevo) |
| `src/assets/services/chatService.js` | `sendMessage`, `editMessage`, `decryptMessage`, `getMessages`; `last_message_text` como marcador |
| `src/assets/services/migrations/082_e2e_chat.sql` | Esquema, helpers, trigger y políticas (nuevo) |
| `src/assets/Pages/Chat.jsx` | Estado "esperando clave", aviso de dispositivo, badge de cifrado |
| `src/context/AuthContext.jsx` | `ensureDevice()`, borrar claves de memoria al salir |
| `src/assets/services/i18n/locales/{es,en}.json` | Cadenas nuevas (`npm run validate-locales`) |
| `docs/database/SUPABASE_REFERENCE.md` | Tablas y políticas nuevas |

`alphabetEncryption.js` **no se toca**: sigue sirviendo a posts y a los mensajes
v1. El módulo nuevo es independiente para poder revertir el flag.

---

## 11. Límites y metadatos que quedan

- Quién habla con quién, cuándo y cuánto (tamaño del ciphertext).
- `shared_post_id`, `shared_community_id`, `shared_invite_token`, `reactions`,
  `is_pinned`, `deleted_for` siguen en claro.
- `last_message_text` deja de filtrar contenido, pero el servidor sabe que hubo
  mensaje.
- Sin búsqueda ni previews en servidor: buscar requiere descifrar en cliente.
- Notificaciones push con contenido exigirían cifrar el payload al dispositivo.
- Un dispositivo perdido sin otro dispositivo aprobado = historial perdido.
- El CDN puede negar el servicio o borrar blobs (no puede leerlos).
- **Sin firmas por remitente.** La clave es compartida, así que un participante
  puede fabricar un ciphertext con el AAD correcto y que la UI lo muestre como
  si fuera del otro. AES-GCM autentica el mensaje, no la identidad del autor, y
  la política `Update conversation messages` (033) permite a un participante
  reescribir filas ajenas. Se corrige con una clave **ECDSA por dispositivo**
  que firme `{id, conversation_id, epoch, ciphertext}`; `sender_device_id` ya
  está previsto para eso. Es el siguiente paso natural tras la fase 3.

---

## 12. Plan por fases

| Fase | Contenido | Verificación |
|---|---|---|
| 0 | Quitar el preview en claro de `last_message_text` y la URL de imagen; documentar que el historial v1 es descifrable por el servidor | Leer `conversations` en DevTools: sin texto ni URLs |
| 1 | `082`, identidad de dispositivo, envoltura, envío/lectura v2 con flag, fallback v1 por capacidades | `scripts/test-e2e-chat.mjs` (dos dispositivos simulados), dos navegadores reales, dump sin IDB no descifra |
| 2 | Imágenes cifradas con blob opaco en el CDN | Abrir `/cdn/files/<id>` sin sesión devuelve bytes inútiles; la imagen se ve solo descifrada |
| 3 | Aprobación de dispositivos, huellas, rotación y revocación | Revocar un dispositivo y comprobar que no lee mensajes nuevos |

**Pruebas automatizadas propuestas** (`scripts/test-e2e-chat.mjs`, Node ≥ 20 con
`globalThis.crypto`): ida y vuelta de texto y binario; AAD incorrecto falla;
clave de otro epoch falla; dispositivo revocado no recibe wrap; dos dispositivos
del mismo usuario desenvuelven la misma clave.

---

## 13. Lo que este diseño evita a propósito

- Guardar la clave de conversación en el servidor, aunque sea "cifrada con una
  clave del servidor": volvería a ser descifrable por el operador.
- Derivar claves de UUID o de datos que el servidor conoce.
- Escrow/recovery con passphrase en el MVP: multiplica superficie y contradice
  el objetivo. Si se añade, será opcional, explícito y con Argon2id + AES-GCM
  sobre un archivo exportado por el usuario.
- Cifrar solo el texto y dejar las imágenes públicas, como hoy.

---

## 14. Esfuerzo estimado

~700-900 líneas nuevas (módulo `e2e/` + migración + UI) y ~150 líneas modificadas
en `chatService.js`, `Chat.jsx` y `src/context/AuthContext.jsx`. El coste real no es la
criptografía (WebCrypto resuelve todo) sino los estados de borde: dispositivo
nuevo, clave pendiente, cambio de huella y downgrade.
