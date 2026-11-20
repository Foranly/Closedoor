-- ==============================================
-- Migration 104: Bookmarks (colecciones de guardados)
-- ==============================================
-- Los guardados dejan de ser una lista única: cada save puede ir dentro de una
-- colección privada ("Bookmarks") que el usuario crea desde el perfil.
--
-- Privacidad: todo esto es SOLO del dueño. `saved_posts` ya es owner-only
-- (migración 007); las colecciones copian exactamente las mismas políticas.
-- `collection_id` es NULLABLE: los guardados que ya existían (y los que se
-- hagan sin elegir colección) siguen apareciendo en "Todos los guardados".
--
-- ON DELETE SET NULL: borrar una colección no borra los posts guardados, solo
-- los devuelve a la lista general.

CREATE TABLE IF NOT EXISTS public.bookmark_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bookmark_collections_name_len CHECK (char_length(btrim(name)) BETWEEN 1 AND 40)
);

-- Nombre único por usuario (sin distinguir mayúsculas: "Música" == "música").
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookmark_collections_user_name
  ON public.bookmark_collections (user_id, lower(btrim(name)));

CREATE INDEX IF NOT EXISTS idx_bookmark_collections_user
  ON public.bookmark_collections (user_id, created_at DESC);

ALTER TABLE public.bookmark_collections ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'bookmark_collections'
      AND policyname = 'Users can view their own bookmark collections'
  ) THEN
    CREATE POLICY "Users can view their own bookmark collections"
      ON public.bookmark_collections FOR SELECT
      USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'bookmark_collections'
      AND policyname = 'Users can insert their own bookmark collections'
  ) THEN
    CREATE POLICY "Users can insert their own bookmark collections"
      ON public.bookmark_collections FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'bookmark_collections'
      AND policyname = 'Users can update their own bookmark collections'
  ) THEN
    CREATE POLICY "Users can update their own bookmark collections"
      ON public.bookmark_collections FOR UPDATE
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'bookmark_collections'
      AND policyname = 'Users can delete their own bookmark collections'
  ) THEN
    CREATE POLICY "Users can delete their own bookmark collections"
      ON public.bookmark_collections FOR DELETE
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── UPDATE en saved_posts ──
-- La migración 007 solo definió SELECT/INSERT/DELETE. El guardado usa upsert
-- (para poder mover un save de colección sin chocar con UNIQUE(user_id,
-- post_id)), y eso necesita UPDATE.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'saved_posts'
      AND policyname = 'Users can update their own saves'
  ) THEN
    CREATE POLICY "Users can update their own saves"
      ON public.saved_posts FOR UPDATE
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- ── Colección en cada guardado ──
ALTER TABLE public.saved_posts
  ADD COLUMN IF NOT EXISTS collection_id UUID
  REFERENCES public.bookmark_collections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_saved_posts_collection
  ON public.saved_posts (collection_id);

-- Una colección solo puede contener guardados de su propio dueño: el chequeo
-- no puede expresarse en un FK, así que se valida con trigger (la RLS de
-- bookmark_collections impide además leer/usar la colección de otro).
CREATE OR REPLACE FUNCTION public.saved_posts_collection_owner_check()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.collection_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.bookmark_collections c
      WHERE c.id = NEW.collection_id AND c.user_id = NEW.user_id
    ) THEN
      RAISE EXCEPTION 'collection_id does not belong to the saving user'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_saved_posts_collection_owner ON public.saved_posts;
CREATE TRIGGER trg_saved_posts_collection_owner
  BEFORE INSERT OR UPDATE OF collection_id, user_id ON public.saved_posts
  FOR EACH ROW EXECUTE FUNCTION public.saved_posts_collection_owner_check();
