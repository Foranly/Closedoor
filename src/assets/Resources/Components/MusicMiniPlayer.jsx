import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { FaPlay, FaPause, FaTimes, FaExpand, FaSpinner } from 'react-icons/fa';
import { useI18n } from '../../services/i18n/useI18n';
import { useAuth } from '../../../hooks/useAuth';
import SongArtwork from './SongArtwork';
import EmojiText from './EmojiText';
import './css/musicMiniPlayer.css';

function formatTime(s) {
  if (!isFinite(s) || s <= 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * MusicMiniPlayer — ventana flotante del reproductor global (ver
 * context/MusicPlayerContext.jsx).
 *
 * - Arrastrable por cualquier zona que no sea un control (pointer events, sin
 *   librería, igual que CallOverlay). La posición se mantiene dentro del viewport.
 * - Botones: play/pausa, expandir (perfil del dueño de la canción) y cerrar.
 * - Barra de progreso clicable para hacer seek.
 * - Se oculta sola cuando ya hay otro reproductor montado en pantalla
 *   (perfil del dueño de la canción) para no duplicar la card "Mi canción".
 */
export default function MusicMiniPlayer({
  track,
  playing,
  currentTime,
  duration,
  loading,
  sourceReady,
  onTogglePlay,
  onSeek,
  onClose,
}) {
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [pos, setPos] = useState(null); // { x, y } tras arrastrar (null = CSS por defecto)
  const [dragging, setDragging] = useState(false);
  const ref = useRef(null);
  const dragRef = useRef(null);

  const song = track?.song || null;
  const owner = track?.owner || null;
  const isOwnSong = !!user?.id && owner?.id === user.id;
  const ownerHandle = owner?.username ? String(owner.username).toLowerCase() : '';

  // ── Sólo se pinta si hay canción cargada ──
  const songId = song?.trackId || '';

  // ── Arrastrar (pointer events) ──
  const handlePointerDown = useCallback((e) => {
    if (typeof e.button === 'number' && e.button !== 0) return;
    // Los controles de la ventana no inician arrastre
    if (e.target?.closest?.('button, [data-no-drag]')) return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: rect.left,
      originY: rect.top,
      w: rect.width,
      h: rect.height,
      moved: false,
    };
    setDragging(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no soportado */ }
  }, []);

  const handlePointerMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return; // todavía es un click
    d.moved = true;
    setPos({
      x: Math.max(8, Math.min(d.originX + dx, window.innerWidth - d.w - 8)),
      y: Math.max(8, Math.min(d.originY + dy, window.innerHeight - d.h - 8)),
    });
  }, []);

  const endDrag = useCallback((e) => {
    dragRef.current = null;
    setDragging(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* no soportado */ }
  }, []);

  // Reposicionar dentro del viewport al redimensionar la ventana
  useEffect(() => {
    if (!pos) return;
    const onResize = () => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPos((p) => (p ? {
        x: Math.max(8, Math.min(p.x, window.innerWidth - rect.width - 8)),
        y: Math.max(8, Math.min(p.y, window.innerHeight - rect.height - 8)),
      } : p));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [pos]);

  // ── Saltar al perfil del dueño de la canción ──
  const openOwnerProfile = useCallback(() => {
    if (dragRef.current?.moved) return;
    if (isOwnSong) {
      navigate('/Profile');
      return;
    }
    if (ownerHandle) navigate(`/profile/${ownerHandle}`);
  }, [isOwnSong, ownerHandle, navigate]);

  if (!song) return null;

  // En el perfil del dueño de la canción ya se ve la card "Mi canción" con sus
  // propios controles → la ventana flotante sobraría.
  const route = String(pathname || '').toLowerCase();
  const onOwnerProfile = isOwnSong
    ? route === '/profile'
    : (!!ownerHandle && route === `/profile/${ownerHandle}`);
  if (onOwnerProfile) return null;

  const pct = duration > 0 ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0;
  const canExpand = isOwnSong || !!ownerHandle;

  const handleSeekClick = (e) => {
    if (!duration || !onSeek) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(ratio * duration);
  };

  return createPortal(
    <div
      ref={ref}
      className={`music-mini${dragging ? ' music-mini--dragging' : ''}`}
      style={pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      data-song={songId}
    >
      <div className="music-mini-body">
        <button
          type="button"
          className="music-mini-art"
          onClick={openOwnerProfile}
          disabled={!canExpand}
          title={canExpand ? (t('music.view_profile') || 'View profile') : undefined}
        >
          <SongArtwork
            song={song}
            className="music-mini-art-img"
            emptyClassName="music-mini-art-img--empty"
            draggable={false}
          />
          <span className={`music-mini-art-disc${playing ? ' music-mini-art-disc--playing' : ''}`}>
            {loading ? <FaSpinner className="fc-spin" /> : (playing ? <FaPause /> : <FaPlay />)}
          </span>
        </button>

        <div className="music-mini-info">
          <span className="music-mini-title" title={song.title}><EmojiText text={song.title} /></span>
          <span className="music-mini-artist" title={song.artist}><EmojiText text={song.artist || t('music.now_playing') || 'Now playing'} /></span>
        </div>

        <div className="music-mini-actions">
          <button
            type="button"
            className="music-mini-btn music-mini-btn--toggle"
            onClick={onTogglePlay}
            disabled={loading}
            title={playing ? (t('profile.song_pause') || 'Pause') : (t('profile.song_play') || 'Play')}
          >
            {loading ? <FaSpinner className="fc-spin" /> : (playing ? <FaPause /> : <FaPlay />)}
          </button>
          {canExpand && (
            <button
              type="button"
              className="music-mini-btn music-mini-btn--expand"
              onClick={openOwnerProfile}
              title={t('music.view_profile') || 'View profile'}
            >
              <FaExpand />
            </button>
          )}
          <button
            type="button"
            className="music-mini-btn music-mini-btn--close"
            onClick={onClose}
            title={t('music.close_player') || 'Close player'}
          >
            <FaTimes />
          </button>
        </div>
      </div>

      <div
        className="music-mini-progress"
        data-no-drag
        role="slider"
        aria-label={t('music.now_playing') || 'Now playing'}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration) || 0}
        aria-valuenow={Math.round(currentTime) || 0}
        onClick={handleSeekClick}
      >
        <span className="music-mini-progress-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="music-mini-times">
        <span>{formatTime(currentTime)}</span>
        <span>{sourceReady ? formatTime(duration) : '--:--'}</span>
      </div>
    </div>,
    document.body
  );
}
