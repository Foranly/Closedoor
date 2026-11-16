import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FaPlay, FaPause, FaBackward, FaForward, FaRedo,
  FaVolumeUp, FaVolumeDown, FaVolumeMute, FaExpand, FaCompress,
  FaExpandArrowsAlt, FaWindowMinimize, FaTimes,
} from 'react-icons/fa';
import { useI18n } from '../../services/i18n/useI18n';
import { useFloatingVideo } from '../../../context/FloatingVideoContext.jsx';

const SEEK_STEP = 10; // segundos por salto
// Ratio de reserva cuando el post no guardó video_meta. La caja del reproductor
// tiene SIEMPRE un alto derivado (aspect-ratio) desde el primer render: así la
// fila virtualizada se mide una sola vez y las cards de abajo no saltan cuando
// el <video> carga los metadatos.
const DEFAULT_RATIO = 16 / 9;

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * PostVideoPlayer — reproductor de los videos de los posts.
 *
 * Los videos solo se adjuntan por URL (el CDN todavía no procesa video), así
 * que el <video> consume la URL tal cual. Controles propios: play/pausa,
 * retroceder/avanzar 10 s, repetir, volumen con mute, pantalla completa, PiP y
 * minimizar a una ventana flotante.
 *
 * Virtualización (VirtualPostList):
 *   • El contenedor reserva el alto con `aspect-ratio` y ese ratio es FIJO: no
 *     se recalcula al llegar los metadatos. La lista mide la fila una vez y no
 *     aparecen huecos ni saltos al hacer scroll.
 *   • Minimizar transfiere la reproducción (tiempo, volumen, loop) al host
 *     flotante montado en <body> con un portal, así el video sigue sonando
 *     aunque la fila se desmonte al salir del overscan.
 *   • Un IntersectionObserver pausa el video inline que sale de la vista: nunca
 *     se queda sonando fuera de pantalla. No se reanuda solo al volver.
 */
export default function PostVideoPlayer({ src, title, ratio: savedRatio = 0, className = '' }) {
  const floating = useFloatingVideo();
  const isFloatHost = Boolean(floating?.isHost);
  const openFloating = floating?.open ?? null;
  const closeFloating = floating?.close ?? null;
  // El estado de reanudación solo interesa al reproductor del host flotante.
  const resume = isFloatHost ? floating?.resumeState ?? null : null;
  const resumeId = resume?.id ?? null;

  const { t } = useI18n();
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  // Última transferencia pendiente de aplicar en loadedmetadata (seek + play).
  const resumeRef = useRef(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(false);
  const [isPip, setIsPip] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Ratio estable: el guardado por el post, el que trae el host flotante o el
  // neutro. Nunca cambia durante la vida del componente.
  const ratio = (resume?.ratio > 0 && resume.ratio) || (savedRatio > 0 && savedRatio) || DEFAULT_RATIO;

  // ── Sincronizar estado con el elemento <video> ──
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    // La card se reutiliza al cambiar de fila en la lista virtualizada: el
    // estado tiene que partir de cero, no del video anterior.
    setCurrentTime(0);
    setDuration(0);
    setPlaying(false);

    resumeRef.current = resume;
    if (resume) {
      const vol = Number.isFinite(resume.volume) ? resume.volume : 1;
      video.volume = vol;
      video.muted = Boolean(resume.muted) || vol === 0;
      video.loop = Boolean(resume.loop);
      setVolume(vol);
      setMuted(video.muted);
      setLoop(Boolean(resume.loop));
    }

    const onTime = () => setCurrentTime(video.currentTime);
    const onMeta = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      const pending = resumeRef.current;
      if (!pending) return;
      // El seek/play se aplica una sola vez: al repetirse loadedmetadata (otra
      // fuente, recarga) no debe volver a saltar al segundo transferido.
      resumeRef.current = null;
      if (Number.isFinite(pending.time) && pending.time > 0) {
        video.currentTime = pending.time;
        setCurrentTime(pending.time);
      }
      if (pending.playing) {
        video.play().catch(() => {
          // Autoplay bloqueado con audio: reintenta silenciado.
          if (!video.muted) {
            video.muted = true;
            video.play().catch(() => {});
          }
        });
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onVolume = () => { setVolume(video.volume); setMuted(video.muted); };
    const onEnded = () => setPlaying(false);
    const onEnterPip = () => setIsPip(true);
    const onLeavePip = () => setIsPip(false);

    video.addEventListener('timeupdate', onTime);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('durationchange', onMeta);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('volumechange', onVolume);
    video.addEventListener('ended', onEnded);
    video.addEventListener('enterpictureinpicture', onEnterPip);
    video.addEventListener('leavepictureinpicture', onLeavePip);

    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('durationchange', onMeta);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('volumechange', onVolume);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('enterpictureinpicture', onEnterPip);
      video.removeEventListener('leavepictureinpicture', onLeavePip);
    };
  }, [src, resumeId]);

  // ── Pantalla completa (el evento cubre también la salida con Escape) ──
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // ── IntersectionObserver: el video inline que sale de la vista se pausa.
  //    No se reanuda solo: si el usuario vuelve, pulsará play.
  useEffect(() => {
    if (isFloatHost) return undefined;
    const node = containerRef.current;
    const video = videoRef.current;
    if (!node || !video || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) continue;
        if (video.paused || video.ended || video.seeking) continue;
        // No pausar si el usuario lo tiene en PiP o a pantalla completa.
        if (document.pictureInPictureElement === video || document.fullscreenElement) continue;
        video.pause();
      }
    }, { threshold: 0 });
    io.observe(node);
    return () => io.disconnect();
  }, [src, isFloatHost]);

  const minimize = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    // Ya en el host flotante: lo único que queda es PiP (si el entorno lo
    // soporta). Sin PiP el host ya es la ventana minimizada.
    if (isFloatHost) {
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') {
        try { await video.requestPictureInPicture(); } catch { /* sin soporte */ }
      }
      return;
    }

    if (document.pictureInPictureElement === video) {
      document.exitPictureInPicture?.().catch(() => {});
      return;
    }

    if (openFloating) {
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      openFloating({
        src,
        title,
        ratio,
        time: video.currentTime,
        playing: !video.paused && !video.ended && !video.seeking,
        volume: video.volume,
        muted: video.muted,
        loop,
      });
      // Detiene el inline: el host crea su propio <video> y continúa ahí.
      video.pause();
    }
  }, [isFloatHost, openFloating, src, title, ratio, loop]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }, []);

  const seekBy = useCallback((delta) => {
    const video = videoRef.current;
    if (!video) return;
    const max = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
    const next = Math.min(Math.max((video.currentTime || 0) + delta, 0), max);
    video.currentTime = next;
    setCurrentTime(next);
  }, []);

  const toggleLoop = useCallback(() => {
    setLoop((prev) => {
      const next = !prev;
      if (videoRef.current) videoRef.current.loop = next;
      return next;
    });
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
  }, []);

  const changeVolume = useCallback((value) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = value;
    video.muted = value === 0;
  }, []);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else container.requestFullscreen?.().catch(() => {});
  }, []);

  if (!src) return null;

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const mutedNow = muted || volume === 0;

  return (
    <div
      ref={containerRef}
      className={`post-video-player${className ? ` ${className}` : ''}`}
      style={{ aspectRatio: ratio }}
    >
      <video
        ref={videoRef}
        src={src}
        className="post-video-player-el"
        preload="metadata"
        playsInline
        title={title || undefined}
        onClick={(e) => { e.stopPropagation(); togglePlay(); }}
      />

      {isFloatHost && closeFloating && (
        <button
          type="button"
          className="post-video-player-close-host"
          onClick={(e) => { e.stopPropagation(); closeFloating(); }}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <FaTimes />
        </button>
      )}

      <div className="post-video-player-controls" onClick={(e) => e.stopPropagation()}>
        <input
          type="range"
          className="post-video-player-progress"
          min="0"
          max="100"
          step="0.1"
          value={progress}
          onChange={(e) => {
            const video = videoRef.current;
            if (!video || !duration) return;
            const time = (Number(e.target.value) / 100) * duration;
            video.currentTime = time;
            setCurrentTime(time);
          }}
          onClick={(e) => e.stopPropagation()}
          aria-label={t('post.video_progress')}
        />

        <button
          type="button"
          className="post-video-player-btn"
          onClick={togglePlay}
          aria-label={playing ? t('post.video_pause') : t('post.video_play')}
          title={playing ? t('post.video_pause') : t('post.video_play')}
        >
          {playing ? <FaPause /> : <FaPlay />}
        </button>

        <button
          type="button"
          className="post-video-player-btn"
          onClick={() => seekBy(-SEEK_STEP)}
          aria-label={t('post.video_seek_back')}
          title={t('post.video_seek_back')}
        >
          <FaBackward />
        </button>

        <button
          type="button"
          className="post-video-player-btn"
          onClick={() => seekBy(SEEK_STEP)}
          aria-label={t('post.video_seek_forward')}
          title={t('post.video_seek_forward')}
        >
          <FaForward />
        </button>

        <span className="post-video-player-time">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>

        <button
          type="button"
          className={`post-video-player-btn${loop ? ' post-video-player-btn--active' : ''}`}
          onClick={toggleLoop}
          aria-pressed={loop}
          aria-label={t('post.video_loop')}
          title={t('post.video_loop')}
        >
          <FaRedo />
        </button>

        <div className="post-video-player-volume">
          <button
            type="button"
            className="post-video-player-btn"
            onClick={toggleMute}
            aria-label={mutedNow ? t('post.video_unmute') : t('post.video_mute')}
            title={mutedNow ? t('post.video_unmute') : t('post.video_mute')}
          >
            {mutedNow ? <FaVolumeMute /> : volume < 0.5 ? <FaVolumeDown /> : <FaVolumeUp />}
          </button>
          <input
            type="range"
            className="post-video-player-volume-range"
            min="0"
            max="1"
            step="0.05"
            value={muted ? 0 : volume}
            onChange={(e) => changeVolume(Number(e.target.value))}
            aria-label={t('post.video_volume')}
          />
        </div>

        <span className="post-video-player-spacer" />

        <button
          type="button"
          className={`post-video-player-btn${isPip ? ' post-video-player-btn--active' : ''}`}
          onClick={minimize}
          aria-label={isPip ? t('post.video_expand') : t('post.video_minimize')}
          title={isFloatHost ? t('post.video_pip') : t('post.video_minimize')}
        >
          {isPip ? <FaExpandArrowsAlt /> : <FaWindowMinimize />}
        </button>

        <button
          type="button"
          className="post-video-player-btn"
          onClick={toggleFullscreen}
          aria-label={t('post.video_fullscreen')}
          title={t('post.video_fullscreen')}
        >
          {isFullscreen ? <FaCompress /> : <FaExpand />}
        </button>
      </div>
    </div>
  );
}
