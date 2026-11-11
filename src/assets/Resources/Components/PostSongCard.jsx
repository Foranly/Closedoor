import { FaMusic, FaPause, FaPlay, FaSpinner } from 'react-icons/fa';
import { useI18n } from '../../services/i18n/useI18n';
import { useMusicPlayer } from '../../../hooks/useMusicPlayer';
import { songKey } from '../../services/musicService';
import SongArtwork from './SongArtwork';

/**
 * PostSongCard — canción adjunta a un post.
 *
 * La reproducción la lleva el reproductor GLOBAL (context/MusicPlayerContext),
 * igual que la canción del perfil y la del chat: el stream completo se pide al
 * backend (servidor local de la app de escritorio → canción entera) y, si
 * falla —lo normal en la web—, cae al preview de 30 s guardado en `post.song`.
 *
 * `song` es el jsonb `posts.song` ({ provider, trackId, title, artist, album,
 * artwork, previewUrl, externalUrl, duration }).
 */
export default function PostSongCard({ song }) {
  const { t } = useI18n();
  const {
    track,
    playing: playerPlaying,
    loadingStream,
    sourceReady,
    toggleTrack,
  } = useMusicPlayer();

  if (!song?.title) return null;

  const isActive = songKey(track?.song) === songKey(song);
  const isPlaying = isActive && playerPlaying;
  const loading = isActive && loadingStream;
  // Sin preview se puede reproducir si hay trackId (el player resuelve por
  // videoId); sin ninguno de los dos no hay nada que pedir.
  const canPlay = !!(song.previewUrl || song.trackId)
    && typeof toggleTrack === 'function'
    && (!isActive || sourceReady);

  const label = loading
    ? t('profile.song_loading')
    : isPlaying
      ? t('profile.song_pause')
      : t('profile.song_play');

  return (
    <div
      className={`post-card-song${isPlaying ? ' post-card-song--playing' : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={`post-card-song-art${canPlay ? '' : ' post-card-song-art--disabled'}`}
        onClick={() => { if (canPlay) toggleTrack(song, null); }}
        disabled={!canPlay}
        aria-pressed={isPlaying}
        aria-label={label}
        title={label}
      >
        <SongArtwork
          song={song}
          className="post-card-song-art-img"
          emptyClassName="post-card-song-art-img--empty"
          loading="lazy"
        />
        <span className="post-card-song-overlay" aria-hidden="true">
          {loading ? <FaSpinner className="fc-spin" /> : (isPlaying ? <FaPause /> : <FaPlay />)}
        </span>
      </button>

      <div className="post-card-song-info">
        <span className="post-card-song-title" title={song.title}>{song.title}</span>
        {song.artist && (
          <span className="post-card-song-artist" title={song.artist}>{song.artist}</span>
        )}
      </div>

      <FaMusic className="post-card-song-icon" aria-hidden="true" />
    </div>
  );
}
