import { useEffect, useRef, useState } from 'react';
import { FaMusic, FaPlay, FaPause, FaPencilAlt, FaTrash, FaSearch, FaSpinner } from 'react-icons/fa';
import { useI18n } from '../../services/i18n/useI18n';
import { useAuth } from '../../../hooks/useAuth';
import { searchMusic, songArtworkUrl, songKey, withPreviewFallback } from '../../services/musicService';
import SongArtwork from './SongArtwork';
import EmojiText from './EmojiText';
import { useMusicPlayer } from '../../../hooks/useMusicPlayer';
import { updateUserProfile } from '../../services/userService';
import { toast } from 'react-toastify';
import './css/songCard.css';

function formatTime(s) {
  if (!isFinite(s) || s <= 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Card "Mi canción" del sidebar del perfil (arriba de los intereses).
 * - La canción completa se reproduce desde /api/music/stream: el backend la
 *   resuelve con innertube y la sirve con soporte de Range → el <audio> hace
 *   streaming progresivo y permite seek. Ya no hay blob local ni túneles: el
 *   navegador consume el stream directo. La base la elige musicService según
 *   dónde corra la app (services/desktopApp.js): en el NAVEGADOR es el mismo
 *   origen y YouTube suele negar el stream completo (IP de datacenter → bot
 *   check), así que lo normal es caer al preview de 30 s; en la APP DE
 *   ESCRITORIO apunta a su servidor local (127.0.0.1:5990) y la canción suena
 *   entera por la IP del usuario.
 * - Al arrancar la reproducción en el navegador se ofrece la app de escritorio
 *   (Components/DesktopAppPrompt: descargar / cerrar / no volver a mostrar).
 * - El resolver elige el formato de audio que quepa ENTERO en el tramo que
 *   entrega YouTube (~1 MiB por URL): canciones cortas en 131 kbps y canciones
 *   largas en el mejor bitrate que quepa (p. ej. 32 kbps) para que suenen
 *   completas. Si ninguna cabría, o el stream falla, cae al preview de 30 s
 *   (iTunes / Deezer).
 * - En el perfil propio permite buscar, elegir, cambiar y quitar la canción
 *   inline (sin abrir el modal de edición).
 * - La reproducción la lleva el REPRODUCTOR GLOBAL (context/MusicPlayerContext):
 *   esta card sólo pinta el estado. Así la música sigue sonando al navegar y la
 *   ventana flotante (Components/MusicMiniPlayer) ofrece play/pausa, arrastre,
 *   cierre y salto al perfil del dueño de la canción.
 */
export default function SongCard({ song, isOwnProfile, surfaceStyle, owner }) {
  const { t } = useI18n();
  const { user } = useAuth();

  // Guard: solo tratar como canción si el shape es válido. `previewUrl` es
  // opcional: las canciones de YouTube se reproducen con el stream completo y
  // el preview solo existe como respaldo.
  const songObj = song && typeof song === 'object' && song?.title ? song : null;

  // ── Estado del song (synced desde el perfil) ──
  const [selected, setSelected] = useState(songObj || null);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [saving, setSaving] = useState(false);

  // ── Playback: lo gestiona el reproductor GLOBAL ──
  // El <audio> ya no vive aquí: al navegar a otra ruta la música sigue sonando
  // (context/MusicPlayerContext.jsx + ventana flotante MusicMiniPlayer).
  const {
    track,
    playing: playerPlaying,
    currentTime: playerTime,
    duration: playerDuration,
    loadingStream,
    sourceReady,
    toggleTrack,
  } = useMusicPlayer();

  const activeKey = songKey(selected);
  const isActive = !!activeKey && activeKey === songKey(track?.song);
  const playing = isActive && playerPlaying;
  const currentTime = isActive ? playerTime : 0;
  const duration = isActive ? (playerDuration || selected?.duration || 0) : (selected?.duration || 0);
  const loadingHere = isActive && loadingStream;
  // Fuera de la canción activa el player todavía no resolvió nada: se permite
  // pulsar (él resuelve y arranca). Si es la activa, se espera a tener fuente.
  const canPlay = !isActive || sourceReady;


  // ── Sync cuando cambia el song del perfil (realtime / navegación) ──
  const songSig = songObj ? `${songObj.provider}:${songObj.trackId}` : '';
  const prevSigRef = useRef(songSig);

  useEffect(() => {
    if (prevSigRef.current === songSig) return;
    prevSigRef.current = songSig;
    setSelected(songObj || null);
  }, [songObj, songSig]);

  // Perfil ajeno sin canción → no mostrar la card (después de los hooks)
  if (!isOwnProfile && !selected) return null;

  const togglePlay = () => {
    if (!selected || !canPlay) return;
    // El reproductor global resuelve el stream (y cae al preview si hace falta)
    // y sigue sonando aunque naveguemos fuera del perfil.
    toggleTrack(selected, owner || null);
  };

  const handleSearch = async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setSearchError('');
    try {
      const { results: found } = await searchMusic(q, { limit: 8 });
      setResults(found);
      if (!found.length) setSearchError(t('profile.song_no_results') || 'No songs found');
    } catch (err) {
      console.warn('[song] search error:', err?.message || err);
      setSearchError(t('profile.song_error') || "Couldn't search music");
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const saveSong = async (track) => {
    if (!user?.id || saving) return;
    setSaving(true);
    try {
      // Las canciones de YouTube no traen preview: se pide uno a iTunes como
      // respaldo del reproductor antes de guardar (best-effort).
      const songToSave = await withPreviewFallback(track);
      await updateUserProfile(user.id, { song: songToSave });
      setSelected(songToSave);
      setEditing(false);
      setResults([]);
      setQuery('');
      setSearchError('');
      toast.success(t('profile.song_saved') || 'Song saved to your profile');
    } catch (err) {
      console.warn('[song] save error:', err?.message || err);
      toast.error(err?.message || t('profile.error_generic') || 'Error');
    } finally {
      setSaving(false);
    }
  };

  const removeSong = async () => {
    if (!user?.id || saving) return;
    setSaving(true);
    try {
      await updateUserProfile(user.id, { song: null });
      setSelected(null);
      setEditing(false);
      setResults([]);
      setQuery('');
      setSearchError('');
      toast.success(t('profile.song_removed') || 'Song removed from your profile');
    } catch (err) {
      console.warn('[song] remove error:', err?.message || err);
      toast.error(err?.message || t('profile.error_generic') || 'Error');
    } finally {
      setSaving(false);
    }
  };

  const openEditor = () => {
    setEditing(true);
    setQuery('');
    setResults([]);
    setSearchError('');
  };

  const closeEditor = () => {
    setEditing(false);
    setQuery('');
    setResults([]);
    setSearchError('');
  };

  return (
    <div className="profile-sidebar-card" style={surfaceStyle}>
      <h3 className="profile-sidebar-title">
        <FaMusic className="profile-sidebar-title-icon" />
        {t('profile.song_title')}
      </h3>

      {editing ? (
        /* ── Editor inline (perfil propio) ── */
        <div className="song-card-editor">
          <div className="song-card-search-row">
            <input
              className="song-card-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSearch();
                }
              }}
              placeholder={t('profile.song_search_placeholder')}
              autoFocus
            />
            <button
              type="button"
              className="song-card-search-btn"
              onClick={handleSearch}
              disabled={searching || !query.trim()}
              title={t('profile.song_search_btn')}
            >
              {searching ? <FaSpinner className="fc-spin" /> : <FaSearch />}
            </button>
          </div>

          {searching && <p className="song-card-search-msg">{t('profile.song_searching')}</p>}
          {searchError && <p className="song-card-search-msg">{searchError}</p>}

          {results.length > 0 && (
            <>
              <p className="song-card-select-hint">{t('profile.song_select_hint')}</p>
              <div className="song-card-results">
                {results.map((r) => (
                  <button
                    key={`${r.provider}-${r.trackId}`}
                    type="button"
                    className={`song-card-result ${
                      selected?.trackId === r.trackId && selected?.provider === r.provider
                        ? 'song-card-result--selected'
                        : ''
                    }`}
                    onClick={() => saveSong(r)}
                    disabled={saving}
                  >
                    <SongArtwork
                      song={r}
                      className="song-card-result-art"
                      emptyClassName="song-card-result-art--empty"
                      loading="lazy"
                    />
                    <span className="song-card-result-info">
                      <span className="song-card-result-title"><EmojiText text={r.title} /></span>
                      <span className="song-card-result-artist"><EmojiText text={r.artist} /></span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="song-card-editor-actions">
            <button type="button" className="song-card-cancel-btn" onClick={closeEditor} disabled={saving}>
              {t('common.cancel')}
            </button>
            {selected && (
              <button
                type="button"
                className="song-card-remove-btn"
                onClick={removeSong}
                disabled={saving}
              >
                {t('profile.song_remove')}
              </button>
            )}
          </div>
        </div>
      ) : !selected ? (
        /* ── Sin canción (perfil propio): CTA ── */
        <button type="button" className="song-card-add" onClick={openEditor}>
          <FaMusic />
          {t('profile.song_add')}
        </button>
      ) : (
        /* ── Canción fijada: portada + disco a la derecha + info ── */
        <div className="song-card-main">
          {/* Escenario: portada + disco. Tiempo y acciones viven sobre la portada */}
          <div className="song-card-stage">
            {/* Portada: click = play/pausa; tiempo arriba-izq; acciones en hover */}
            <div className="song-card-cover-wrap">
              <button
                type="button"
                className={`song-card-cover ${!canPlay ? 'song-card-cover--disabled' : ''}`}
                onClick={togglePlay}
                aria-pressed={playing}
                disabled={!canPlay}
                title={loadingHere ? t('profile.song_loading') || 'Loading…' : (playing ? t('profile.song_pause') : t('profile.song_play'))}
              >
                <SongArtwork
                  song={selected}
                  className="song-card-cover-img"
                  emptyClassName="song-card-cover-img--empty"
                  alt={selected.title || ''}
                  loading="lazy"
                />
                <span className="song-card-cover-time">
                  {formatTime(currentTime)} / {formatTime(duration)}
                </span>
                <span className="song-card-cover-btn">
                  {loadingHere ? <FaSpinner className="fc-spin" /> : (playing ? <FaPause /> : <FaPlay />)}
                </span>
              </button>

              {/* Editar / eliminar: solo perfil propio, visibles en hover (o siempre en táctil) */}
              {isOwnProfile && (
                <div className="song-card-cover-actions">
                  <button
                    type="button"
                    className="song-card-cover-action"
                    onClick={openEditor}
                    title={t('profile.song_change')}
                  >
                    <FaPencilAlt />
                  </button>
                  <button
                    type="button"
                    className="song-card-cover-action song-card-cover-action--danger"
                    onClick={removeSong}
                    disabled={saving}
                    title={t('profile.song_remove')}
                  >
                    <FaTrash />
                  </button>
                </div>
              )}
            </div>

            {/* Disco de vinilo: a la derecha de la portada, asomando la mitad */}
            <button
              type="button"
              className={`song-card-vinyl ${playing ? 'song-card-vinyl--playing' : ''}`}
              onClick={togglePlay}
              aria-pressed={playing}
              disabled={!canPlay}
              title={playing ? t('profile.song_pause') : t('profile.song_play')}
            >
              <span
                className="song-card-vinyl-art"
                style={songArtworkUrl(selected) ? { backgroundImage: `url(${songArtworkUrl(selected)})` } : undefined}
              />
            </button>
          </div>

          {/* Título/artista (el progreso se ve en el contador de la portada) */}
          <div className="song-card-info">
            <span className="song-card-texts">
              <span className="song-card-title"><EmojiText text={selected.title} /></span>
              <span className="song-card-artist"><EmojiText text={selected.artist} /></span>
            </span>
          </div>
        </div>
      )}

      {/* El <audio> vive en el reproductor global (context/MusicPlayerContext)
          para que la música siga sonando al cambiar de ruta. */}
    </div>
  );
}
