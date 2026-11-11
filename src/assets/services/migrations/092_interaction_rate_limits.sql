-- ==============================================
-- Migration 092: rate limit de interacciones (DB-level)
-- ==============================================
-- Hasta ahora no había ningún límite en las escrituras: un cliente podía
-- martillear la API (posts, comentarios, likes, reposts, follows, mensajes)
-- sin más freno que la RLS. RLS autoriza, no limita volumen.
--
-- Se añade un contador genérico de ventana fija + triggers BEFORE INSERT en las
-- tablas de interacción. Va en la DB (no en el cliente) para que valga también
-- para llamadas directas a la API con el JWT del usuario.
--
-- Ajustar límites = cambiar los argumentos del trigger correspondiente:
--   EXECUTE FUNCTION public.enforce_rate_limit('posts', '10', '600')
--                                          (bucket, máx, ventana en segundos)
--
-- Límites actuales (los de spam real, no los de uso normal):
--   posts          10 / 10 min
--   comments       20 / 5 min   (comentarios y respuestas)
--   likes          60 / 1 min
--   comment_likes  60 / 1 min
--   reposts        15 / 10 min
--   follows        40 / 1 h
--   messages       60 / 1 min
--
-- Los triggers no aplican a operaciones hechas por el dueño de la tabla desde
-- el SQL Editor/backfills (esos corren como postgres, pero el trigger sí se
-- ejecuta): si alguna migración futura inserta en bloque, desactívelo con
-- `ALTER TABLE ... DISABLE TRIGGER rate_limit_<tabla>;` o suba el límite.
--
-- Error devuelto al cliente: SQLSTATE P0001 con mensaje `rate_limited:<bucket>`
-- (el cliente lo traduce en helpers.isRateLimitError → toast "vas demasiado
-- rápido").

-- ── Contadores ──
CREATE TABLE IF NOT EXISTS public.rate_limit_hits (
  bucket       text        NOT NULL,
  subject      uuid        NOT NULL,
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, subject, window_start)
);

ALTER TABLE public.rate_limit_hits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limit_hits FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_cleanup
  ON public.rate_limit_hits (window_start);

-- ── Consumo atómico de una ventana ──
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_bucket  text,
  p_max     integer,
  p_seconds integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_subject      uuid := auth.uid();
  v_window_start timestamptz;
  v_hits         integer;
BEGIN
  IF v_subject IS NULL THEN
    RAISE EXCEPTION 'rate_limited:unauthenticated';
  END IF;

  -- Limpieza oportunista: las ventanas viejas no sirven y la tabla es pequeña.
  DELETE FROM rate_limit_hits
   WHERE subject = v_subject
     AND window_start < now() - interval '1 day';

  v_window_start := to_timestamp(
    floor(extract(epoch FROM now()) / p_seconds) * p_seconds
  );

  INSERT INTO rate_limit_hits AS r (bucket, subject, window_start, hits)
  VALUES (p_bucket, v_subject, v_window_start, 1)
  ON CONFLICT (bucket, subject, window_start)
  DO UPDATE SET hits = r.hits + 1
  RETURNING hits INTO v_hits;

  IF v_hits > p_max THEN
    RAISE EXCEPTION 'rate_limited:%', p_bucket;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.check_rate_limit(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) TO authenticated;

-- ── Trigger genérico: los límites viven en los argumentos ──
CREATE OR REPLACE FUNCTION public.enforce_rate_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.check_rate_limit(
    TG_ARGV[0],
    TG_ARGV[1]::integer,
    TG_ARGV[2]::integer
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_rate_limit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_rate_limit() TO authenticated;

-- ── Triggers por interacción ──

DROP TRIGGER IF EXISTS rate_limit_posts ON public.posts;
CREATE TRIGGER rate_limit_posts
  BEFORE INSERT ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_rate_limit('posts', '10', '600');

DROP TRIGGER IF EXISTS rate_limit_comments ON public.comments;
CREATE TRIGGER rate_limit_comments
  BEFORE INSERT ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_rate_limit('comments', '20', '300');

DROP TRIGGER IF EXISTS rate_limit_likes ON public.likes;
CREATE TRIGGER rate_limit_likes
  BEFORE INSERT ON public.likes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_rate_limit('likes', '60', '60');

DROP TRIGGER IF EXISTS rate_limit_comment_likes ON public.comment_likes;
CREATE TRIGGER rate_limit_comment_likes
  BEFORE INSERT ON public.comment_likes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_rate_limit('comment_likes', '60', '60');

DROP TRIGGER IF EXISTS rate_limit_reposts ON public.reposts;
CREATE TRIGGER rate_limit_reposts
  BEFORE INSERT ON public.reposts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_rate_limit('reposts', '15', '600');

DROP TRIGGER IF EXISTS rate_limit_follows ON public.follows;
CREATE TRIGGER rate_limit_follows
  BEFORE INSERT ON public.follows
  FOR EACH ROW EXECUTE FUNCTION public.enforce_rate_limit('follows', '40', '3600');

DROP TRIGGER IF EXISTS rate_limit_messages ON public.messages;
CREATE TRIGGER rate_limit_messages
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.enforce_rate_limit('messages', '60', '60');
