import Parser from 'rss-parser';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const SOURCES = [
  // Design
  { name: "It's Nice That", url: 'https://www.itsnicethat.com/feed', category: 'design' },
  { name: 'Creative Boom', url: 'https://www.creativeboom.com/feed/', category: 'design' },
  { name: 'Brand New', url: 'https://feeds.feedburner.com/UnderConsideration-BrandNew', category: 'design' },
  { name: 'The Brand Identity', url: 'https://the-brandidentity.com/feed', category: 'design' },
  { name: 'Fast Company Co.Design', url: 'https://www.fastcompany.com/co-design/rss', category: 'design' },
  { name: 'Dezeen', url: 'https://www.dezeen.com/feed/', category: 'design' },
  { name: 'AIGA Eye on Design', url: 'https://eyeondesign.aiga.org/feed/', category: 'design' },
  { name: 'The Dieline', url: 'https://thedieline.com/blog?format=rss', category: 'design' },

  // Motion
  { name: 'Motionographer', url: 'https://motionographer.com/feed/', category: 'motion' },
  { name: 'Cartoon Brew', url: 'https://www.cartoonbrew.com/feed', category: 'motion' },
  { name: 'Stash Media', url: 'https://stashmedia.tv/feed/', category: 'motion' },
  { name: 'School of Motion', url: 'https://www.schoolofmotion.com/blog/rss.xml', category: 'motion' },
  { name: 'Animation Magazine', url: 'https://www.animationmagazine.net/feed/', category: 'motion' },
  { name: 'Art of the Title', url: 'https://www.artofthetitle.com/feed/', category: 'motion' },

  // Sport
  { name: 'Front Office Sports', url: 'https://frontofficesports.com/feed/', category: 'sport' },
  { name: 'Sportico', url: 'https://www.sportico.com/feed/', category: 'sport' },
  { name: 'SportsPro Media', url: 'https://www.sportspromedia.com/rss/news/', category: 'sport' },
  { name: 'Sports Business Journal', url: 'https://www.sportsbusinessjournal.com/RSS/Latest-News.aspx', category: 'sport' },

  // UX
  { name: 'Smashing Magazine', url: 'https://www.smashingmagazine.com/feed/', category: 'ux' },
  { name: 'Nielsen Norman Group', url: 'https://www.nngroup.com/feed/rss/', category: 'ux' },
  { name: 'UX Collective', url: 'https://uxdesign.cc/feed', category: 'ux' },
  { name: 'A List Apart', url: 'https://alistapart.com/main/feed/', category: 'ux' },
  { name: 'Codrops', url: 'https://tympanus.net/codrops/feed/', category: 'ux' },
  { name: 'Figma Blog', url: 'https://www.figma.com/blog/feed/atom.xml', category: 'ux' },
  { name: 'Awwwards Blog', url: 'https://www.awwwards.com/blog/feed.xml', category: 'ux' },

  // Marketing
  { name: 'Adweek', url: 'https://www.adweek.com/feed/', category: 'marketing' },
  { name: 'Marketing Brew', url: 'https://www.marketingbrew.com/feed', category: 'marketing' },
  { name: 'Ad Age', url: 'https://adage.com/rss.xml', category: 'marketing' },
  { name: 'The Drum', url: 'https://www.thedrum.com/rss.xml', category: 'marketing' },
  { name: 'Marketing Dive', url: 'https://www.marketingdive.com/feeds/news/', category: 'marketing' },
  { name: 'Contagious', url: 'https://www.contagious.com/news-and-views/rss', category: 'marketing' },
];

const MAX_AGE_HOURS = 48;
const FEED_TIMEOUT_MS = 15_000;
const IMAGE_TIMEOUT_MS = 15_000;
const IMAGE_MAX_WIDTH = 800;
const IMAGE_QUALITY = 75;
const IMAGE_RETENTION_DAYS = 7;
const EXCERPT_MAX = 200;

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA_DIR = path.join(ROOT, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const OUTPUT_FILE = path.join(DATA_DIR, 'daily-brief.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const HTML_TIMEOUT_MS = 8_000;
const HTML_MAX_BYTES = 512 * 1024; // og:image lives in <head>; cap to keep memory low
const ARTICLE_TIMEOUT_MS = 30_000; // wall-clock cap per article so one stuck request can't block Promise.all

async function main() {
  await fs.mkdir(IMAGES_DIR, { recursive: true });

  const parser = new Parser({
    timeout: FEED_TIMEOUT_MS,
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
    customFields: {
      item: [
        ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
        ['media:content', 'mediaContent', { keepArray: true }],
        ['content:encoded', 'contentEncoded'],
      ],
    },
  });

  const cutoff = Date.now() - MAX_AGE_HOURS * 3600 * 1000;
  const t0 = Date.now();

  const fetchResults = await Promise.allSettled(
    SOURCES.map((source) => fetchSource(parser, source, cutoff)),
  );

  const collected = [];
  for (let i = 0; i < SOURCES.length; i++) {
    const source = SOURCES[i];
    const r = fetchResults[i];
    if (r.status === 'fulfilled') {
      collected.push(...r.value);
      console.log(`✓ ${source.name.padEnd(28)} ${r.value.length} articles`);
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.log(`✗ ${source.name.padEnd(28)} FAILED: ${msg}`);
    }
  }

  const seen = new Set();
  const unique = collected.filter((a) => (seen.has(a.url) ? false : (seen.add(a.url), true)));

  console.log(`\nProcessing images for ${unique.length} unique articles…`);
  let imagesFromRss = 0;
  let imagesFromOg = 0;
  let imagesFailed = 0;
  let imagesTimedOut = 0;
  await Promise.all(
    unique.map(async (article) => {
      const raw = article._rawImageUrl;
      delete article._rawImageUrl;

      const work = (async () => {
        if (raw) {
          try {
            const img = await processImage(raw, article.id);
            return { kind: 'rss', img };
          } catch {}
        }
        try {
          const ogUrl = await extractOgImage(article.url);
          if (ogUrl) {
            const img = await processImage(ogUrl, article.id);
            return { kind: 'og', img };
          }
        } catch {}
        return { kind: 'none' };
      })();

      const TIMEOUT = Symbol('timeout');
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), ARTICLE_TIMEOUT_MS);
      });
      const result = await Promise.race([work, timeout]);
      clearTimeout(timer);

      if (result === TIMEOUT) {
        article.image = null;
        imagesTimedOut++;
      } else if (result.kind === 'rss') {
        article.image = result.img;
        imagesFromRss++;
      } else if (result.kind === 'og') {
        article.image = result.img;
        imagesFromOg++;
      } else {
        article.image = null;
        imagesFailed++;
      }
    }),
  );
  console.log(`Images: ${imagesFromRss} from RSS, ${imagesFromOg} from og:image, ${imagesFailed} none, ${imagesTimedOut} timed out`);

  unique.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  const byCategory = { design: 0, motion: 0, sport: 0, ux: 0, marketing: 0 };
  for (const a of unique) byCategory[a.category] = (byCategory[a.category] ?? 0) + 1;

  const output = {
    generatedAt: new Date().toISOString(),
    totalArticles: unique.length,
    byCategory,
    articles: unique,
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2) + '\n');
  console.log(`\n✓ Wrote ${unique.length} articles to ${path.relative(ROOT, OUTPUT_FILE)}`);

  await pruneOldImages(unique);

  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function fetchSource(parser, source, cutoff) {
  const feed = await parser.parseURL(source.url);
  const items = feed.items ?? [];
  return items
    .filter((item) => {
      const pub = parseDate(item.isoDate ?? item.pubDate);
      return pub !== null && pub > cutoff;
    })
    .map((item) => normalizeArticle(item, source));
}

function normalizeArticle(item, source) {
  const url = (item.link ?? '').trim();
  const id = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const publishedAtMs = parseDate(item.isoDate ?? item.pubDate) ?? Date.now();
  return {
    id,
    title: stripText(item.title ?? '(untitled)').slice(0, 240),
    url,
    source: source.name,
    category: source.category,
    publishedAt: new Date(publishedAtMs).toISOString(),
    excerpt: extractExcerpt(item),
    image: null,
    _rawImageUrl: extractImageUrl(item),
  };
}

function parseDate(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function stripText(s) {
  return String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function extractExcerpt(item) {
  const raw = item.contentSnippet ?? item.summary ?? item.contentEncoded ?? item.content ?? '';
  return stripText(raw).slice(0, EXCERPT_MAX);
}

function extractImageUrl(item) {
  const enc = item.enclosure;
  if (enc && typeof enc === 'object') {
    const u = enc.url;
    const t = enc.type ?? '';
    if (u && (/^image\//i.test(t) || /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(u))) return u;
  }

  const fromMedia = (arr) => {
    if (!Array.isArray(arr)) return null;
    for (const m of arr) {
      const u = m?.$?.url;
      if (u) return u;
    }
    return null;
  };
  const mt = fromMedia(item.mediaThumbnail);
  if (mt) return mt;
  const mc = fromMedia(item.mediaContent);
  if (mc) return mc;

  const html = item.contentEncoded ?? item.content ?? item.summary ?? '';
  const m = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  return m?.[1] ?? null;
}

async function extractOgImage(articleUrl) {
  if (!articleUrl) return null;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HTML_TIMEOUT_MS);
  try {
    const res = await fetch(articleUrl, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok || !res.body) return null;

    // Stream up to HTML_MAX_BYTES, decode, then stop — og:image lives in <head>.
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let html = '';
    let bytes = 0;
    while (bytes < HTML_MAX_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    try { await reader.cancel(); } catch {}

    const m =
      html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i) ??
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    if (!m) return null;
    return new URL(m[1], articleUrl).toString();
  } finally {
    clearTimeout(t);
  }
}

async function processImage(rawUrl, articleId) {
  const filename = `${articleId}.webp`;
  const filepath = path.join(IMAGES_DIR, filename);
  const relpath = `data/images/${filename}`;

  try {
    await fs.access(filepath);
    return relpath;
  } catch {}

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  let buf;
  try {
    const res = await fetch(rawUrl, {
      headers: {
        'User-Agent': UA,
        Accept: 'image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }

  await sharp(buf, { failOn: 'none' })
    .rotate()
    .resize({ width: IMAGE_MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: IMAGE_QUALITY, effort: 4 })
    .toFile(filepath);

  return relpath;
}

async function pruneOldImages(currentArticles) {
  const keep = new Set();
  for (const a of currentArticles) {
    if (a.image) keep.add(path.basename(a.image));
  }
  const ageThreshold = Date.now() - IMAGE_RETENTION_DAYS * 24 * 3600 * 1000;
  let pruned = 0;
  let entries;
  try {
    entries = await fs.readdir(IMAGES_DIR);
  } catch {
    return;
  }
  for (const f of entries) {
    if (keep.has(f)) continue;
    const fp = path.join(IMAGES_DIR, f);
    try {
      const stat = await fs.stat(fp);
      if (stat.mtimeMs < ageThreshold) {
        await fs.unlink(fp);
        pruned++;
      }
    } catch {}
  }
  if (pruned > 0) console.log(`Pruned ${pruned} stale image(s) older than ${IMAGE_RETENTION_DAYS}d`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
