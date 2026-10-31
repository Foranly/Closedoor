# AlphabetEncryption — contenido ofuscado y cifrado

Implementación: `src/assets/services/alphabetEncryption.js` (documentada aquí porque
acompaña al hook que la usa).

## Concepto

Sistema que permite a un usuario crear publicaciones con contenido ofuscado, visible
solo para las personas que el autor seleccione explícitamente.

## Encoding alfabético (ofuscación visual)

Cada letra del alfabeto se mapea a un número palindrómico:

```
a = 2112      b = 4114      c = 6116      d = 8118
e = 101110    f = 121112    g = 141114    h = 161116
i = 181118    j = 201120    k = 221122    l = 241124
m = 261126    n = 281128    o = 301130    p = 321132
q = 341134    r = 361136    s = 381138    t = 401140
u = 421142    v = 441144    w = 461146    x = 481148
y = 501150    z = 521152
```

**Fórmula:** `letra_n = (n*2) + "11" + (n*2)` donde n es la posición en el alfabeto (1-indexed).

Ejemplo: `"hola"` → `161116 301130 241124 2112` → `1611163011302411242112`

También incluye caracteres extendidos (espacio, puntuación, números). El texto se
pasa a minúsculas antes de codificar y los caracteres sin código se descartan; `decode`
reconstruye solo lo que existe en el mapa, así que no es un códec reversible para
texto arbitrario (su función es la ofuscación visual, no proteger nada).

## Capas de seguridad

| Capa | Propósito | Implementación |
|---|---|---|
| **Ofuscación visual** | Mostrar texto "codificado" en la UI | Encoding palindrómico (sin clave) |
| **Encriptación real** | Proteger el contenido real | AES-256-GCM con Web Crypto API |
| **Control de acceso** | Solo usuarios seleccionados pueden descifrar | Clave derivada de `autor + userIds` vía PBKDF2 (100 000 iteraciones, SHA-256) |

## Flujo de creación

1. El usuario escribe el contenido en `CreatePostModal`.
2. Activa el toggle **Ofuscar contenido**.
3. Selecciona qué usuarios pueden verlo (autocompletado de seguidos).
4. Al guardar se persisten:
   - `content`: el texto original (lo ven el autor y los autorizados)
   - `is_encrypted = true`
   - `encrypted_content` + `encrypted_iv`: AES-256-GCM en base64
   - `allowed_users`: UUIDs de los usuarios seleccionados
   - `obfuscated_display`: la codificación alfabética, que es lo que ve el resto

## Flujo de visualización

- **Autor**: ve el contenido original.
- **Usuario en `allowed_users`**: se descifra automáticamente con AES (y se cachea por
  `postId|userId` para no repetir la derivación).
- **Usuario no autorizado**: ve `obfuscated_display` (el código numérico).
- **No autenticado**: ve un mensaje de bloqueo en lugar del contenido.

La verificación de autorización es doble: RLS en `posts` y el chequeo
`allowed_users.includes(currentUserId)` antes de descifrar.

## Derivación de la clave

La semilla de PBKDF2 es `autorId + '|' + userIdsOrdenados.join(',')`:

- **No depende del `postId`**, lo que permite cifrar antes de crear el registro.
- Dos publicaciones del mismo autor con los mismos invitados comparten clave, así que
  las claves se cachean (LRU de 200 promesas): abrir un chat de 40 mensajes no repite
  40 derivaciones.
- Si cambia el conjunto de usuarios permitidos, cambia la clave y el contenido anterior
  deja de descifrarse con la nueva lista (el autor debe re-cifrar al editarlo).
- No se almacena ninguna clave ni contraseña en el servidor.

## API Reference

```js
import {
  encode, decode, getObfuscatedDisplay,
  encryptForUsers, decryptForUser,
  getCachedDecryptedContent, setCachedDecryptedContent, clearDecryptedCache,
} from '../services/alphabetEncryption';

// Ofuscación visual
encode('hola mundo');                 // "1611160000301130..." (texto en minúsculas)
decode('1611163011302411242112');     // "hola"
getObfuscatedDisplay(encoded, 30);    // recorta para la vista previa

// Encriptación real (AES-256-GCM)
const { ciphertext, iv } = await encryptForUsers(content, authorId, allowedUserIds);

// Descifrado: null si el usuario no está en allowedUserIds
const text = await decryptForUser(ciphertext, iv, authorId, allowedUserIds, currentUserId);

// Caché de texto descifrado (por postId + userId)
setCachedDecryptedContent(postId, userId, text);
getCachedDecryptedContent(postId, userId);   // undefined si no está cacheado
clearDecryptedCache();                       // al cerrar sesión
```