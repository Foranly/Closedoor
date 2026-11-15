/**
 * Vercel serverless function that generates a dynamic sitemap.xml
 * with all public profiles and recent non-encrypted posts from Supabase.
 *
 * Route: /sitemap.xml
 * Output: XML sitemap with up to 1000 public profile URLs + 500 public post URLs
 */

import { createClient } from '@supabase/supabase-js';
import { buildSitemapUrls, wrapSitemapXml } from './_sitemap.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const SITE_URL = process.env.VITE_SITE_URL || 'https://app.foranly.cloud';

// ── Cache in-memory across invocations (Vercel keeps warm) ──
let cachedXml = null;
let cacheTimestamp = 0;
const CACHE_TTL = 1000 * 60 * 30; // 30 min

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).end('Method not allowed');
    return;
  }

  // ── Return cached sitemap if fresh ──
  if (cachedXml && Date.now() - cacheTimestamp < CACHE_TTL) {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=1800, s-maxage=1800');
    res.status(200).end(cachedXml);
    return;
  }

  const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

  // ── Build sitemap using shared utility ──
  const urls = await buildSitemapUrls(supabase, SITE_URL);
  const xml = wrapSitemapXml(urls);

  // ── Update cache ──
  cachedXml = xml;
  cacheTimestamp = Date.now();

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=1800, s-maxage=1800');
  res.status(200).end(xml);
}
