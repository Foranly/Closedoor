/**
 * Vercel serverless function that injects Open Graph meta tags
 * into /Post/:id pages for crawlers (Discord, Twitter, etc.).
 *
 * Vercel runs this for routes matching /post/:id
 * before serving the SPA fallback.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const FALLBACK_IMAGE = 'https://placehold.co/1200x630/1a1a2e/6b7280?text=Closedoor';

// ── In-memory cache with TTL ──
const postOgCache = new Map();
const POST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
function cacheGet(key) {
  const entry = postOgCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) { postOgCache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) {
  postOgCache.set(key, { data, expiry: Date.now() + POST_CACHE_TTL });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).end('Method not allowed');
    return;
  }

  const match = req.url?.match(/^\/[Pp]ost\/([a-zA-Z0-9-]+)/);
  if (!match) {
    res.status(404).end('Not found');
    return;
  }

  const postId = match[1];

  // ── Check cache ──
  const cacheKey = `post_${postId}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return sendOG(req, res, postId, cached);
  }

  // ── Fetch post data from Supabase ──
  let og = {
    title: 'Post | Closedoor',
    description: 'Check out this post on Closedoor.',
    image: FALLBACK_IMAGE,
    type: 'article',
  };

  if (supabase) {
    try {
      const { data } = await supabase
        .from('posts')
        .select('content, image_url, profiles!posts_user_id_fkey (username, avatar_url)')
        .eq('id', postId)
        .maybeSingle();

      if (data) {
        const cleanContent = data.content
          ? data.content.replace(/<[^>]*>/g, '').replace(/https?:\/\/\S+/g, '').trim()
          : '';
        const authorUsername = data.profiles?.username;

        og = {
          title: authorUsername
            ? `Post by @${authorUsername} | Closedoor`
            : 'Post | Closedoor',
          description: cleanContent
            ? (cleanContent.length > 200 ? cleanContent.slice(0, 200) + '...' : cleanContent)
            : 'Check out this post on Closedoor.',
          image: data.image_url || data.profiles?.avatar_url || FALLBACK_IMAGE,
          type: 'article',
        };
        cacheSet(cacheKey, og);
      }
    } catch (err) {
      console.warn('[og-post] Fetch error:', err.message);
    }
  }

  sendOG(req, res, postId, og);
}

function sendOG(req, res, postId, og) {
  try {
    const htmlPath = join(process.cwd(), 'dist', 'index.html');
    const html = readFileSync(htmlPath, 'utf-8');

    const host = req.headers.host || 'app.foranly.cloud';
    const postUrl = `https://${host}/Post/${postId}`;

    const metaTags = `
    <meta property="og:title" content="${esc(og.title)}" />
    <meta property="og:description" content="${esc(og.description)}" />
    <meta property="og:image" content="${esc(og.image)}" />
    <meta property="og:url" content="${esc(postUrl)}" />
    <meta property="og:type" content="${esc(og.type)}" />
    <meta property="og:site_name" content="${esc('Closedoor')}" />
    <meta name="description" content="${esc(og.description)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(og.title)}" />
    <meta name="twitter:description" content="${esc(og.description)}" />
    <meta name="twitter:image" content="${esc(og.image)}" />`;

    const modifiedHtml = html.replace('</title>', `</title>${metaTags}`);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).end(modifiedHtml);
  } catch (err) {
    console.error('[og-post] Error reading index.html:', err.message);
    res.status(500).end('Internal error');
  }
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
