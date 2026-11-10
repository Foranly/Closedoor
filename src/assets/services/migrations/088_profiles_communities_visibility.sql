-- ==============================================
-- Migration 088: privacidad de las comunidades del perfil
-- ==============================================
-- Añade `communities_visibility`, el ajuste que decide quién ve la pestaña
-- "Comunidades" del perfil:
--
--   'nobody'    → solo el dueño
--   'following' → el dueño y las cuentas que él sigue (por defecto)
--   'everyone'  → cualquiera que pueda ver el perfil
--
-- Implementación (mismo modelo de confianza que la 080):
--   · La regla se aplica EN EL CLIENTE al decidir si se pinta la pestaña y al
--     pedir las membresías (communityService.canViewProfileCommunities).
--   · El dato de membresías ya está protegido por RLS (058): un visitante solo
--     ve membresías de comunidades PÚBLICAS; las privadas solo las ve el propio
--     usuario. Es decir, ni con 'everyone' se filtran comunidades privadas.
--
-- Sin GRANTs: la 071 dejó SELECT/INSERT/UPDATE a nivel TABLA, así que la
-- columna nueva queda legible y escribible sola. RLS limita a auth.uid() = id.
-- Sin índice: se lee junto a la fila del perfil, nunca se filtra por ella.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS communities_visibility TEXT NOT NULL DEFAULT 'following';

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_communities_visibility_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_communities_visibility_check
  CHECK (communities_visibility IN ('nobody', 'following', 'everyone'));

COMMENT ON COLUMN public.profiles.communities_visibility IS
  'Quién ve la pestaña de comunidades del perfil: nobody = solo yo, following = a quien sigo (defecto), everyone = todos.';
