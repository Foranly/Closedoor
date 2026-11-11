import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FaPlay, FaPause, FaBackward, FaForward, FaRedo,
  FaVolumeUp, FaVolumeDown, FaVolumeMute, FaExpand, FaCompress,
  FaExpandArrowsAlt, FaWindowMinimize,
} from 'react-icons/fa';
import { useI18n } from '../../services/i18n/useI18n';

const SEEK_STEP = 10; // segundos por salto

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
 * retroceder/avanzar 10 s, reiniciar, repetir, volumen con mute, pantalla
 * completa y modo minimizado (ventana flotante abajo a la derecha que sigue
 * reproduciendo mientras se hace scroll; el elemento <video> no se mueve del
 * DOM, solo cambia de posición con CSS, así que la reproducción no se corta).
 *
 * Los embeds de YouTube/Vimeo no pasan por aquí: los pinta PostCard como
 * iframe, porque su reproducción no se puede controlar desde fuera.
 */
export default function PostVideoPlayer({ src, title, ratio: savedRatio = 0, className = '' }) {
  const { t } = useI18n();
  const videoRef = useRef(null);
  const containerRef = useRef(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [isPip, setIsPip] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Ratio real del archivo: el contenedor se ajusta a él para no dejar huecos
  // ni deformar el video en burbujas o cards más anchas.
  // Si el post guardó las dimensiones al publicar, el hueco queda con el
  // tamaño final antes de que cargue el video (sin salto de altura).
  const [ratio, setRatio] = useState(savedRatio > 0 ? savedRatio : 0);

  // ── Sincronizar estado con el elemento <video> ──
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    // Al cambiar de video (la card se reutiliza en listas virtualizadas) el
    // estado tiene que partir de cero, no del video anterior.
    setCurrentTime(0);
    setDuration(0);
    setPlaying(false);
    setRatio(savedRatio > 0 ? savedRatio : 0);

    const onTime = () => setCurrentTime(video.currentTime);
    const onMeta = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      if (video.videoWidth && video.videoHeight) {
        setRatio(video.videoWidth / video.videoHeight);
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onVolume = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };
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
  }, [src, savedRatio]);

  // ── Pantalla completa (se sigue con el evento para cubrir Escape) ──
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  /**
   * Minimizar = ventana flotante. Se intenta Picture-in-Picture (ventana del
   * navegador, escapa de contenedores con transform/filter y sigue al hacer
   * scroll) y, si el entorno no lo soporta (p. ej. Electron sin PiP), se cae
   * al modo mini CSS anclado a la esquina de la card.
   */
  const minimize = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    if (document.pictureInPictureElement) {
      document.exitPictureInPicture?.().catch(() => {});
      return;
    }

    if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') {
      try {
        await video.requestPictureInPicture();
        setMinimized(false);
        return;
      } catch {
        // Sin permiso o sin soporte real: seguir con el mini de la card.
      }
    }

    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    setMinimized((prev) => !prev);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, []);

  const seekBy = useCallback((delta) => {
    const video = videoRef.current;
    if (!video) return;
    const next = Math.min(Math.max((video.currentTime || 0) + delta, 0), duration || video.duration || 0);
    video.currentTime = next;
    setCurrentTime(next);
  }, [duration]);

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
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    } else {
      container.requestFullscreen?.().catch(() => {});
    }
  }, []);

  if (!src) return null;

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const VolumeIcon = muted || volume === 0 ? FaVolumeMute : volume < 0.5 ? FaVolumeDown : FaVolumeUp;

  return (
    <div
      ref={containerRef}
      className={`post-video-player${minimized ? ' post-video-player--mini' : ''}${className ? ` ${className}` : ''}`}
      style={ratio ? { aspectRatio: ratio } : undefined}
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

      {minimized && (
        <button
          type="button"
          className="post-video-player-restore"
          onClick={(e) => { e.stopPropagation(); setMinimized(false); }}
          aria-label={t('post.video_expand')}
          title={t('post.video_expand')}
        >
          <FaExpandArrowsAlt />
        </button>
      )}

      <div className="post-video-player-controls" onClick={(e) => e.stopPropagation()}>
        {/* ── Barra de progreso (fila propia encima de los botones) ── */}
        <input
          type="range"
          className="post-video-player-progress"
          min="0"
          max="100"
          step="0.1"
          value={progress}
          onChange={(e) => {
            e.stopPropagation();
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
            aria-label={muted ? t('post.video_unmute') : t('post.video_mute')}
            title={muted ? t('post.video_unmute') : t('post.video_mute')}
          >
            <VolumeIcon />
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
          className={`post-video-player-btn${minimized || isPip ? ' post-video-player-btn--active' : ''}`}
          onClick={minimize}
          aria-label={minimized || isPip ? t('post.video_expand') : t('post.video_minimize')}
          title={minimized || isPip ? t('post.video_expand') : t('post.video_minimize')}
        >
          <FaWindowMinimize />
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
