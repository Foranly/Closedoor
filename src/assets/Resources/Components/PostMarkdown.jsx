import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isSafeUrl } from '../../services/helpers';
import { remarkMentionsAndTags } from '../../services/postMarkdown';
import { remarkTwemoji, TWEMOJI_CLASS } from '../../services/twemoji';

/**
 * PostMarkdown — renderiza el contenido de un post con markdown (GFM),
 * manteniendo el comportamiento de RichText:
 *  - @menciones → /profile/{username} (link interno)
 *  - #hashtags  → /hashtag/{tag} (link interno)
 *  - URLs externas con confirmación (onExternalLink) y filtro isSafeUrl
 *  - skipUrls: URLs de media que se muestran aparte, no en el texto
 *
 * No se permite HTML crudo (react-markdown sin rehype-raw): se muestra escapado.
 * Las imágenes markdown (`![alt](url)`) NO se renderizan como <img>: los posts
 * ya tienen su propio sistema de media (image_urls + image_meta + límite de 4),
 * así que se muestran como link para no saltárselo.
 */
export default function PostMarkdown({
  text,
  skipUrls = [],
  onExternalLink,
  linkClass = 'post-card-link',
  mentionClass = 'post-card-mention',
  hashtagClass = 'post-card-hashtag',
  className = 'post-markdown',
  emojiImages = true,
}) {
  const skipKey = skipUrls.join('|');

  const source = useMemo(() => {
    let value = text || '';
    const urls = skipKey ? skipKey.split('|') : [];
    for (const url of urls) {
      if (url) value = value.split(url).join('');
    }
    return value;
  }, [text, skipKey]);

  const components = useMemo(() => ({
    a: ({ href = '', children }) => {
      if (href.startsWith('/profile/') || href.startsWith('/hashtag/')) {
        return (
          <Link
            to={href}
            className={href.startsWith('/profile/') ? mentionClass : hashtagClass}
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </Link>
        );
      }
      if (!isSafeUrl(href)) return <span>{children}</span>;
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
          onClick={(e) => {
            e.stopPropagation();
            if (onExternalLink) {
              e.preventDefault();
              onExternalLink(href);
            }
          }}
        >
          {children}
        </a>
      );
    },
    img: ({ src = '', alt = '', className: imgClassName }) => {
      const imgClass = Array.isArray(imgClassName) ? imgClassName.join(' ') : imgClassName;
      if (typeof imgClass === 'string' && imgClass.includes(TWEMOJI_CLASS)) {
        return (
          <img
            src={src}
            alt={alt}
            className={imgClass}
            draggable={false}
          />
        );
      }
      const label = alt || src;
      if (!src || !isSafeUrl(src)) return <span>{label}</span>;
      return (
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
          onClick={(e) => {
            e.stopPropagation();
            if (onExternalLink) {
              e.preventDefault();
              onExternalLink(src);
            }
          }}
        >
          {label}
        </a>
      );
    },
  }), [linkClass, mentionClass, hashtagClass, onExternalLink]);

  const remarkPlugins = useMemo(
    () => (emojiImages
      ? [remarkGfm, remarkMentionsAndTags, remarkTwemoji]
      : [remarkGfm, remarkMentionsAndTags]),
    [emojiImages],
  );

  if (!text) return null;

  return (
    <div className={className}>
      {/* Sin rehype-raw: el HTML crudo nunca se interpreta. Sin `skipHtml`
          tampoco se descarta: se muestra como texto escapado, así el post
          no pierde contenido si el autor escribe `<algo>`. */}
      <Markdown
        remarkPlugins={remarkPlugins}
        components={components}
      >
        {source}
      </Markdown>
    </div>
  );
}
