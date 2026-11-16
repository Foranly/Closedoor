import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getStreamUrl, prewarmStream, resolvePreviewUrl, songKey } from '../assets/services/musicService';
import { isDesktopApp, notifyBrowserPlayback } from '../assets/services/desktopApp';
import { MusicPlayerContext } from './musicContext';
import MusicMiniPlayer from '../assets/Resources/Components/MusicMiniPlayer';

/**
 * MusicPlayerProvider — reproductor GLOBAL de "Mi canción".
 *
 * Antes cada SongCard tenía su propio <audio>, así que al navegar a otra ruta el
 * componente se desmontaba y la música se cortaba. Aquí vive UN único elemento
 * <audio> montado durante toda la vida de la app: la reproducción sobrevive a
 * los cambios de ruta y la ventana flotante (MusicMiniPlayer) permite
 * pausar/reanudar, arrastrar, cerrar y saltar al perfil del dueño de la canción.
 *
 * El motor de reproducción (preview de 30 s → stream completo en escritorio,
 * reintento único, reanudación al cambiar de src) es el mismo que tenía
 * SongCard; sólo se movió de sitio para que sea global.
 *
 * ORDEN DE FUENTES: fuera de la app de escritorio el preview de 30 s es la
 * PRIMERA opción. El stream completo lo resuelve innertube en el backend, y
 * YouTube solo entrega audio a IPs de confianza: desde el datacenter de
 * producción falla siempre, así que intentarlo primero solo añade la espera del
 * fallo antes de caer al preview. Solo la app de escritorio (servidor local en
 * 127.0.0.1, sale por la IP del usuario) resuelve el stream completo; en dev se
 * mantiene el intento porque el plugin local sí lo resuelve.
 *
 * Estado:
 *  - track   : { song, owner } de la canción cargada (null = nada)
 * Expone: toggleTrack, pause, seek, close, track, playing, currentTime, duration,
 * loadingStream, sourceReady.
 */
export function MusicPlayerProvider({ children }) {
  const [track, setTrack] = useState(null); // { song, owner }
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // true cuando el stream completo falló y hay que caer al preview de 30s
  const [usePreview, setUsePreview] = useState(false);
  // `playable: false` = la pista NO cabe entera en el tramo que entrega YouTube
  // (~1 MiB por URL): en ese caso se reproduce directo el preview de 30 s.
  const [streamInfo, setStreamInfo] = useState({ key: '', playable: true });
  // Intento de stream en curso (0 = primero). Al fallar se reintenta UNA vez con
  // otro valor: el backend ignora el parámetro, sólo sirve para forzar al <audio>
  // a recargar la misma URL (instancia fría en serverless).
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [loadingStream, setLoadingStream] = useState(false);
  const [resolvedPreview, setResolvedPreview] = useState({ key: '', url: null });
  const audioRef = useRef(null);
  const wantsPlayRef = useRef(false);
  const streamRetriedRef = useRef(false);

  // ¿Merece la pena intentar el stream completo? Solo donde innertube puede
  // funcionar: app de escritorio (servidor propio) o dev server (plugin local).
  const streamFirst = isDesktopApp() || import.meta.env.DEV;

  const song = track?.song || null;
  const selSig = songKey(song);

  const isDeezer = song?.provider === 'deezer' && !!song?.trackId;
  // iTunes: preview estable → src derivado directo del song.
  // Deezer: usa la URL resuelta SOLO si pertenece a la canción actual.
  const effectivePreviewSrc = isDeezer
    ? (resolvedPreview.key === selSig ? resolvedPreview.url : null)
    : (song?.previewUrl || null);

  // ── Reset del estado de reproducción al cambiar de canción ──
  // Se hace en el propio cambio de pista (no en un efecto, para no provocar
  // renders en cascada): TODA transición pasa por toggleTrack/close.
  const resetPlaybackState = useCallback((nextSong) => {
    setCurrentTime(0);
    setDuration(nextSong?.duration || 0);
    setUsePreview(false);
    setStreamAttempt(0);
    setStreamInfo({ key: songKey(nextSong), playable: true });
    setLoadingStream(false);
    setPlaying(false);
    streamRetriedRef.current = false;
    const a = audioRef.current;
    if (a) {
      a.pause();
      try { a.currentTime = 0; } catch { /* sin metadata todavía */ }
    }
  }, []);

  // ── Resolver preview fresco (Deezer) cuando cambia la canción ──
  useEffect(() => {
    if (!isDeezer || !song?.trackId) return;
    let cancelled = false;
    resolvePreviewUrl(song)
      .then((url) => {
        if (cancelled) return;
        setResolvedPreview({ key: selSig, url: url || song.previewUrl });
      })
      .catch(() => {
        if (cancelled) return;
        setResolvedPreview({ key: selSig, url: song.previewUrl });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song]);

  // ── Pre-warm: anticipa la resolución en innertube al cargar la canción ──
  // Se salta fuera de escritorio/dev: si el stream no se va a pedir, resolverlo
  // por adelantado solo gasta una petición y 20 s de reloj.
  useEffect(() => {
    if (!song || !streamFirst) return;
    let cancelled = false;
    prewarmStream(song).then((info) => {
      if (cancelled || !info) return;
      setStreamInfo({ key: selSig, playable: info.playable !== false });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song]);

  // ── Fuente de reproducción ──
  // En la web el preview es la fuente por defecto (ver cabecera): el stream solo
  // se pide si el reproductor está en escritorio/dev, o si la canción no tiene
  // preview con el que sonar (mejor intentarlo que dejarla muda).
  const streamUnplayable = !!song && streamInfo.key === selSig && streamInfo.playable === false;
  const preferPreview = !streamFirst && !!song?.previewUrl;
  const useStream = !usePreview && !preferPreview && !streamUnplayable;
  const baseStreamUrl = useStream ? getStreamUrl(song) : null;
  const streamUrl =
    baseStreamUrl && streamAttempt > 0 ? `${baseStreamUrl}&r=${streamAttempt}` : baseStreamUrl;
  const playbackSrc = streamUrl || effectivePreviewSrc;
  const sourceReady = !!playbackSrc || loadingStream;

  const ignorePlaybackError = (err) => {
    if (err?.name === 'AbortError') return; // benigno: el src cambió antes de arrancar
    console.warn('[music] playback error:', err?.message || err);
  };

  // ── Arrancar (o reanudar) cuando hay src y el usuario pidió play ──
  // Event-driven: el src puede cambiar a mitad de la reproducción (stream →
  // preview) y hay que reanudar; también cubre el primer arranque.
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !playbackSrc || !wantsPlayRef.current) return;
    let cancelled = false;
    a.play()
      .then(() => {
        if (cancelled) return;
        setPlaying(true);
        notifyBrowserPlayback();
      })
      .catch(ignorePlaybackError);
    return () => {
      cancelled = true;
    };
  }, [playbackSrc, selSig]);

  // ── API pública ──
  const pause = useCallback(() => {
    wantsPlayRef.current = false;
    const a = audioRef.current;
    if (a) a.pause();
    setPlaying(false);
  }, []);

  const toggleTrack = useCallback((nextSong, owner = null) => {
    // Los resultados de YouTube pueden no tener preview: el stream completo se
    // resuelve por artist+title (o videoId). El preview, si existe, es el
    // respaldo cuando el stream falla.
    if (!nextSong?.title) return;
    const nextKey = songKey(nextSong);
    const currentKey = track ? songKey(track.song) : '';
    if (nextKey && nextKey === currentKey) {
      // Misma canción → alternar play/pausa
      if (playing || wantsPlayRef.current) {
        pause();
      } else {
        wantsPlayRef.current = true;
        const a = audioRef.current;
        if (a && playbackSrc) {
          a.play().then(() => setPlaying(true)).catch(ignorePlaybackError);
        }
      }
      return;
    }
    wantsPlayRef.current = true;
    resetPlaybackState(nextSong);
    setTrack({ song: nextSong, owner: owner || null });
  }, [track, playing, playbackSrc, pause, resetPlaybackState]);

  const seek = useCallback((time) => {
    const a = audioRef.current;
    if (!a) return;
    try {
      a.currentTime = time;
      setCurrentTime(time);
    } catch { /* sin metadata todavía */ }
  }, []);

  const close = useCallback(() => {
    pause();
    resetPlaybackState(null);
    setTrack(null);
  }, [pause, resetPlaybackState]);

  const value = useMemo(() => ({
    track,
    playing,
    currentTime,
    duration,
    loadingStream,
    sourceReady,
    toggleTrack,
    pause,
    seek,
    close,
  }), [track, playing, currentTime, duration, loadingStream, sourceReady, toggleTrack, pause, seek, close]);

  return (
    <MusicPlayerContext.Provider value={value}>
      {children}

      {/* Reproductor único global (nunca se desmonta) */}
      <audio
        ref={audioRef}
        src={playbackSrc || undefined}
        preload="none"
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || song?.duration || 0)}
        onWaiting={() => setLoadingStream(true)}
        onPlaying={() => setLoadingStream(false)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          wantsPlayRef.current = false;
          setPlaying(false);
          setCurrentTime(0);
        }}
        onError={() => {
          if (usePreview) return; // ya estamos en el preview: no hay más fallbacks
          setLoadingStream(false);
          // Reintento único antes de rendirse (instancia fría / 504 pasajero)
          if (streamUrl && !streamRetriedRef.current) {
            streamRetriedRef.current = true;
            setStreamAttempt((n) => n + 1);
            return;
          }
          // El stream completo no cargó → preview de 30 s (sigue sonando si el
          // usuario había pulsado play: el efecto de arranque reanuda).
          if (streamUrl) setUsePreview(true);
        }}
      />

      {/* Ventana flotante: aparece cuando hay canción y no estamos en el perfil
          de su dueño (ahí ya se ve la propia card). */}
      {track?.song && (
        <MusicMiniPlayer
          track={track}
          playing={playing}
          currentTime={currentTime}
          duration={duration}
          loading={loadingStream}
          sourceReady={sourceReady}
          onTogglePlay={() => toggleTrack(track.song, track.owner)}
          onSeek={seek}
          onClose={close}
        />
      )}
    </MusicPlayerContext.Provider>
  );
}
