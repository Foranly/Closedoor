# Pruebas manuales de seguridad de la base de datos

Comprobaciones de RLS y permisos desde el navegador, tabla por tabla. Automatizadas
en `scripts/test-security-full.mjs` y `scripts/test-db-security-detail.mjs`; esto es
la versión manual para reproducir un caso concreto.

---

## Cómo usarlo

1. Abre la app en el navegador y entra a **DevTools → Console**.
2. Carga el cliente una vez por sesión:

```js
const { supabase } = await import('/src/assets/services/supabaseclient.js');
```

3. Pega cada prueba **por separado** y pulsa Enter.
4. Interpretación:

| Respuesta | Significado |
|---|---|
| `permission denied for table …` / `new row violates row-level security` | ✅ RLS funciona |
| `0 filas` (`[]`) en una lectura que debería estar restringida | ✅ RLS funciona |
| Datos ajenos, o la operación se completa sin error | ❌ RLS está fallando en esa tabla |

> Cerrar la pestaña pierde `supabase`: hay que volver a ejecutar la línea de import.

---

## Prueba rápida

```js
console.log('=== PRUEBA RÁPIDA ===');

const { data: p, error: e1 } = await supabase
  .from('profiles').select('id, username').limit(5);
console.log('perfiles:', p, e1);

const { data: ep, error: e2 } = await supabase
  .from('posts').select('id, encrypted_content, is_encrypted')
  .eq('is_encrypted', true).limit(5);
console.log('posts encriptados:', ep, e2);

const { data: cv, error: e3 } = await supabase
  .from('conversations').select('*').limit(5);
console.log('conversaciones:', cv, e3);

const { data: n, error: e4 } = await supabase
  .from('notifications').select('*').limit(10);
console.log('notificaciones:', n, e4);

const { data: m, error: e5 } = await supabase
  .from('messages').select('*').limit(5);
console.log('mensajes:', m, e5);

const { error: e6 } = await supabase
  .from('posts').insert({ user_id: '00000000-0000-0000-0000-000000000000', content: 'test' });
console.log('insert como otro:', e6?.message || '❌ SE INSERTÓ');
```

---

## Nivel 1: lectura de datos ajenos

### 1.1 Perfiles y email

```js
const { data, error } = await supabase
  .from('profiles').select('id, email, username, bio, avatar_url').limit(5);
console.log('perfiles:', data, error);
// ✅ Debe fallar: profiles.email no existe (migración 069).
//    Lo público se lee de profiles_public.
```

### 1.2 Posts encriptados sin permiso

```js
const { data, error } = await supabase
  .from('posts')
  .select('id, content, encrypted_content, is_encrypted, allowed_users')
  .eq('is_encrypted', true).limit(5);
console.log('encriptados:', data, error);
// ✅ Solo los tuyos o aquellos en los que estás en allowed_users
```

### 1.3 Interacciones de otros

```js
const { data, error } = await supabase
  .from('likes').select('*, profiles!inner(username)').limit(10);
console.log('likes:', data, error);
// ✅ anon no puede leer likes/follows/reposts (migración 055)
```

### 1.4 Conversaciones ajenas

```js
const { data, error } = await supabase.from('conversations').select('*').limit(5);
console.log('conversaciones:', data, error);
// ✅ 0 filas: solo ves las tuyas
```

### 1.5 Mensajes sin ser participante

```js
const { data, error } = await supabase.from('messages').select('*').limit(5);
console.log('mensajes:', data, error);
// ✅ 0 filas: solo los de tus conversaciones
```

---

## Nivel 2: escritura no autorizada

### 2.1 Publicar como otro usuario

```js
const { data, error } = await supabase
  .from('posts')
  .insert({ user_id: '00000000-0000-0000-0000-000000000000', content: 'test' });
console.log('post como otro:', data, error);
// ✅ RLS: "new row violates row-level security"
```

### 2.2 Like con datos falsos

```js
const { data, error } = await supabase
  .from('likes')
  .insert({
    user_id: (await supabase.auth.getSession()).data.session?.user?.id || 'anon',
    post_id: '00000000-0000-0000-0000-000000000000',
  });
console.log('like falso:', data, error);
// ✅ Falla por FK o por RLS
```

### 2.3 Seguir a un perfil privado sin solicitud

```js
const { data: privUser } = await supabase
  .from('profiles_public').select('id, username').eq('is_private', true).limit(1);

if (privUser?.[0]) {
  const { data, error } = await supabase.from('follows').insert({
    follower_id: (await supabase.auth.getSession()).data.session?.user?.id,
    following_id: privUser[0].id,
    status: 'accepted',
  });
  console.log('follow directo a privado:', data, error);
  // ✅ Debe quedar en 'pending' o fallar
}
```

---

## Nivel 3: modificar o borrar datos ajenos

### 3.1 Editar el perfil de otro

```js
const { data: other } = await supabase
  .from('profiles_public').select('id, username').limit(1);

if (other?.[0]) {
  const { data, error } = await supabase
    .from('profiles').update({ bio: 'test' }).eq('id', other[0].id);
  console.log('update perfil ajeno:', data, error);
  // ✅ RLS violation
}
```

### 3.2 Borrar un post ajeno

```js
const { data: otherPost } = await supabase
  .from('posts').select('id, user_id').limit(1);

if (otherPost?.[0]) {
  const { data, error } = await supabase
    .from('posts').delete().eq('id', otherPost[0].id);
  console.log('delete post ajeno:', data, error);
  // ✅ 0 filas o error
}
```

### 3.3 Borrar un comentario ajeno

```js
const { data: otherComment } = await supabase
  .from('comments').select('id, user_id').limit(1);

if (otherComment?.[0]) {
  const { data, error } = await supabase
    .from('comments').delete().eq('id', otherComment[0].id);
  console.log('delete comentario ajeno:', data, error);
  // ✅ Solo funciona si eres el autor o el dueño del post
}
```

### 3.4 Desbloquear un bloqueo ajeno

```js
const { data: anyBlock } = await supabase.from('blocks').select('*').limit(1);

if (anyBlock?.[0]) {
  const { data, error } = await supabase
    .from('blocks').delete().eq('id', anyBlock[0].id);
  console.log('desbloquear ajeno:', data, error);
  // ✅ Solo el blocker puede desbloquear
}
```

---

## Nivel 4: notificaciones, llamadas y votos

```js
for (const table of ['notifications', 'calls', 'poll_votes']) {
  const { data, error } = await supabase.from(table).select('*').limit(10);
  console.log(table, data, error);
  // ✅ 0 filas o solo las tuyas
}
```

---

## Nivel 5: login por username (migración 074)

Objetivo: el login por username funciona **solo** con la contraseña correcta y la
base de datos **nunca** devuelve emails de terceros.

### 5.1 `profiles.email` no existe

```js
const { data, error } = await supabase.from('profiles').select('id, email').limit(1);
console.log('profiles.email:', data, error);
// ✅ "column profiles.email does not exist"
```

### 5.2 `auth.users` inaccesible

```js
const { data, error } = await supabase.from('users').select('id, email').limit(1);
console.log('auth.users:', data, error);
// ✅ Falla: esquema auth sin grants a anon/authenticated
```

### 5.3 El RPC antiguo ya no existe

```js
const { data, error } = await supabase.rpc('get_email_by_username', { uname: 'cualquiera' });
console.log('get_email_by_username:', data, error);
// ✅ 404: eliminado en 074
```

### 5.4 Username inexistente → `null`, sin error

```js
const { data, error } = await supabase.rpc('login_email_by_username', {
  uname: 'usuario_que_no_existe_xyz', pwd: 'cualquier_cosa',
});
console.log(data, error);
// ✅ data = null y sin error: no se puede saber si el username existe
```

### 5.5 Username real + contraseña incorrecta → `null`

```js
const { data, error } = await supabase.rpc('login_email_by_username', {
  uname: 'TU_USERNAME', pwd: 'clave_incorrecta_123',
});
console.log(data, error);
// ✅ null: no se filtra el email
```

### 5.6 Credenciales correctas → email de la propia cuenta

```js
const { data, error } = await supabase.rpc('login_email_by_username', {
  uname: 'TU_USERNAME', pwd: 'TU_PASSWORD',
});
console.log(data, error);
// ✅ Solo el email de esa cuenta y resetea el throttle.
// ⚠️ No compartas capturas con tu email real.
```

### 5.7 Throttle anti fuerza bruta

```js
// ⚠️ Usa un username de PRUEBA: 8 fallos bloquean 15 min el par (username + IP)
for (let i = 0; i < 8; i++) {
  await supabase.rpc('login_email_by_username', {
    uname: 'usuario_de_prueba_throttle', pwd: 'mala_' + i,
  });
}
const { data, error } = await supabase.rpc('login_email_by_username', {
  uname: 'usuario_de_prueba_throttle', pwd: 'otra_mala',
});
console.log('throttle:', data, error);
// ✅ null: el límite está activo
```

### 5.8 `email_exists` sin filtrar emails

```js
const { data, error } = await supabase.rpc('email_exists', { addr: 'nadie@example.com' });
console.log(data, error);
// ✅ false (boolean) y sin error; nunca devuelve el email
```

---

## Atajos desde el SQL Editor

Las consultas del SQL Editor corren como `postgres`, así que sirven para **inspeccionar
la configuración**, no para simular un usuario anónimo (para eso, la consola con la
anon key).

```sql
-- políticas activas
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- RLS habilitado y forzado por tabla
SELECT relname AS table_name, relrowsecurity AS rls_enabled, relforcerowsecurity AS rls_forced
FROM pg_class
WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace
ORDER BY relname;

-- grants por columna de profiles (email no debe aparecer en SELECT/UPDATE)
SELECT grantee, privilege_type, column_name
FROM information_schema.column_privileges
WHERE table_name = 'profiles' AND column_name = 'email';
```

El historial de vulnerabilidades encontradas y su corrección está en
[AUDITORIA-SEGURIDAD.md](./AUDITORIA-SEGURIDAD.md).
