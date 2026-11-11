-- ==============================================
-- Migration 093: rate limit con tiempo de espera
-- ==============================================
-- El error de la 092 solo decía `rate_limited:<bucket>`. Para poder mostrar
-- un contador ("reintenta en N s") en el cliente se añade el tiempo que queda
-- de ventana: `rate_limited:<bucket>:<segundos>`.
--
-- Es un reemplazo de `check_rate_limit`; no cambia tablas, triggers ni límites.

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
  v_retry_after  integer;
BEGIN
  IF v_subject IS NULL THEN
    RAISE EXCEPTION 'rate_limited:unauthenticated';
  END IF;

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
    -- Segundos que faltan para que la ventana actual termine.
    v_retry_after := GREATEST(
      1,
      CEIL(extract(epoch FROM (v_window_start + make_interval(secs => p_seconds) - now())))::integer
    );
    RAISE EXCEPTION 'rate_limited:%:%', p_bucket, v_retry_after;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.check_rate_limit(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) TO authenticated;
