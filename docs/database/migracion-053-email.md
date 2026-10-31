# Grant por columna en `profiles` (migraciones 053 → 069)

Nota de contexto sobre cómo se protegió la columna `email` de `profiles`. El SQL
aplicable no se copia aquí para no duplicarlo: vive en
`src/assets/services/migrations/`.

---

## Qué pasó

RLS filtra **filas**, no columnas: con la anon key se podía pedir
`select=id,email,username` y leer todos los emails. La columna tampoco se podía
"ocultar" con una política.

## Cómo se resolvió

| Migración | Qué hace |
|---|---|
| `053_revoke_email_column.sql` | `REVOKE ALL ON public.profiles` y grants explícitos **por columna**; `email` queda solo en `INSERT` (registro). Crea los RPC `SECURITY DEFINER` para login y comprobación de registro. No basta con un `REVOKE` de columna simple: en Supabase no surte efecto. |
| `054_secure_rpcs.sql` | Retira `EXECUTE` de `anon` en los RPC críticos y añade role check (`auth.uid() IS NOT NULL`). |
| `055_hardening_table_access.sql` | RLS en las tablas sociales y `REVOKE SELECT` de las tablas crudas (`posts`, `profiles`): el acceso anónimo va por las vistas `posts_public` / `profiles_public`. |
| `069_drop_profiles_email.sql` | `DROP COLUMN profiles.email`: el email real vive en `auth.users` (privado, gestionado por GoTrue), así que la columna sobraba y era el origen de la fuga. |
| `071_fix_profiles_grants.sql` | Ajusta los grants por columna a las columnas que existen tras las migraciones anteriores. |
| `074_username_login.sql` | Sustituye `get_email_by_username` por `login_email_by_username`, que solo devuelve el email si la contraseña es correcta (y con throttle). |

## Cómo verificarlo

```sql
SELECT grantee, privilege_type, column_name
FROM information_schema.column_privileges
WHERE table_name = 'profiles' AND column_name = 'email';
-- ✅ sin filas: la columna no existe y no hay grants sobre ella
```

```js
// Con la anon key: debe responder 401/permission denied
await supabase.from('profiles').select('id, email').limit(1);
```

Detalle del hallazgo, alcance y pruebas: [../security/AUDITORIA-SEGURIDAD.md](../security/AUDITORIA-SEGURIDAD.md).
