import { FaPause, FaPlay, FaSpinner } from 'react-icons/fa';
import { useI18n } from '../../services/i18n/useI18n';
import { useMusicPlayer } from '../../../hooks/useMusicPlayer';
import { songKey } from '../../services/musicService';
import SongArtwork from './SongArtwork';
import EmojiText from './EmojiText';

/**
 * ChatSongCard — canción compartida en un mensaje del chat.
 *
 * Se pinta FUERA de la burbuja (el mensaje de solo-canción usa
 * `.chat-message-bubble--bare`, igual que las invitaciones a comunidades).
 * La reproducción la lleva el reproductor global (context/MusicPlayerContext),
 * así que la canción sigue sonando al navegar y aparece su ventana flotante.
 *
 * `song` es el jsonb `messages.shared_song` normalizado en chatService
 * ({ provider, trackId, title, artist, album, artwork, previewUrl, duration }).
 */
export default function ChatSongCard({ song }) {
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
  // Los resultados de YouTube pueden no tener preview: el player resuelve el
  // stream por videoId. Con preview (iTunes) o con trackId se puede reproducir.
  const canPlay = !!(song.previewUrl || song.trackId)
    && typeof toggleTrack === 'function'
    && (!isActive || sourceReady);

  const togglePlay = () => {
    if (!canPlay) return;
    toggleTrack(song, null);
  };

  const label = loading
    ? t('profile.song_loading')
    : isPlaying
      ? t('profile.song_pause')
      : t('profile.song_play');

  return (
    <div className={`chat-message-shared-song${isPlaying ? ' chat-message-shared-song--playing' : ''}`}>
      <button
        type="button"
        className={`chat-song-art${canPlay ? '' : ' chat-song-art--disabled'}`}
        onClick={togglePlay}
        disabled={!canPlay}
        aria-pressed={isPlaying}
        aria-label={label}
        title={label}
      >
        <SongArtwork
          song={song}
          className="chat-song-art-img"
          emptyClassName="chat-song-art-img--empty"
          loading="lazy"
        />
        <span className="chat-song-art-overlay">
          {loading ? <FaSpinner className="fc-spin" /> : (isPlaying ? <FaPause /> : <FaPlay />)}
        </span>
      </button>

      <div className="chat-song-info">
        <span className="chat-song-title" title={song.title}><EmojiText text={song.title} /></span>
        <span className="chat-song-artist" title={song.artist}><EmojiText text={song.artist} /></span>
      </div>
    </div>
  );
}
