#!/usr/bin/env node
// Fetcher for the dongchedi-hot-articles skill.
// Pulls hot TOP 5 + article details, downloads images (Node first, screenshot fallback), writes ./hot-articles/state.json.
//
// Run from the desired output directory:
//   node ~/.claude/skills/dongchedi-hot-articles/fetch.mjs

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdirSync, existsSync, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';

const execFileP = promisify(execFile);

const OUT_ROOT = path.resolve(process.cwd(), 'hot-articles');
const IMG_DIR = path.join(OUT_ROOT, 'images');
if (!existsSync(OUT_ROOT)) mkdirSync(OUT_ROOT, { recursive: true });
if (!existsSync(IMG_DIR)) mkdirSync(IMG_DIR, { recursive: true });

const STATE_PATH = path.join(OUT_ROOT, 'state.json');

const log = (...a) => console.error('[fetch]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function opencli(args) {
  const { stdout } = await execFileP('opencli', [...args, '-f', 'json'], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLI_BROWSER_COMMAND_TIMEOUT: '180000' },
    maxBuffer: 100 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

// `opencli browser eval` prints JSON to stdout but appends update banners. Strip banner lines, then JSON.parse the rest.
function stripBanners(s) {
  return s
    .split('\n')
    .filter((line) => !/^\s*(Update available|Run:|Extension update|Download:)/.test(line))
    .join('\n')
    .trim();
}
async function browserEval(js) {
  const { stdout } = await execFileP('opencli', ['browser', 'eval', js], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLI_BROWSER_COMMAND_TIMEOUT: '60000' },
    maxBuffer: 50 * 1024 * 1024,
  });
  const cleaned = stripBanners(stdout);
  // First valid JSON object/array in output
  const i = cleaned.search(/[{\[]/);
  if (i < 0) throw new Error('no JSON in browser eval output: ' + cleaned.slice(0, 200));
  return JSON.parse(cleaned.slice(i));
}
async function browserOpen(url) {
  await execFileP('opencli', ['browser', 'open', url], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLI_BROWSER_COMMAND_TIMEOUT: '60000' },
    maxBuffer: 10 * 1024 * 1024,
  });
}
async function browserScreenshot(outPath, width, height) {
  await execFileP('opencli', ['browser', 'screenshot', `--width=${width}`, `--height=${height}`, outPath], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLI_BROWSER_COMMAND_TIMEOUT: '60000' },
    maxBuffer: 10 * 1024 * 1024,
  });
}

function fetchTo(url, filepath, redirects = 3) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.dongchedi.com/' },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return fetchTo(new URL(res.headers.location, url).toString(), filepath, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const f = createWriteStream(filepath);
      res.pipe(f);
      f.on('finish', () => f.close(() => resolve()));
      f.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  });
}

function hashUrl(url) {
  return createHash('md5').update(url.split('?')[0]).digest('hex').slice(0, 16);
}

// Identity for matching URL to <img src=...> on the article page.
// ByteDance image URLs vary per-request in signature/expires but share <bucket>/<hash> identity.
function urlIdentity(u) {
  const m = (u || '').match(/byteimg\.com\/([^?]+?)(?:~|\?|$)/);
  return m ? m[1] : (u || '');
}

async function downloadImageNode(url) {
  const filename = `${hashUrl(url)}.jpg`;
  const filepath = path.join(IMG_DIR, filename);
  if (existsSync(filepath)) return filename;
  await fetchTo(url, filepath);
  return filename;
}

async function withConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { results[idx] = await fn(items[idx], idx); }
      catch (e) { results[idx] = { __error: e.message }; }
    }
  }));
  return results;
}

// ---------- 1. Hot list ----------
log('1/4 fetching hot TOP 5 with 2 previews each...');
const hot = await opencli(['dongchedi', 'hot', '--limit', '5', '--per', '2']);
log(`  got ${hot.length} topics`);

// ---------- 2. Article details (sequential, single Chrome tab) ----------
log('2/4 fetching article details (~3-5s each)...');
const articleByGid = {};
for (const topic of hot) {
  for (const a of topic.articles || []) {
    if (!a.gid || articleByGid[a.gid] !== undefined) continue;
    log(`  rank ${topic.rank} / ${a.gid} : ${(a.title || '').slice(0, 30)}...`);
    try {
      const data = await opencli(['dongchedi', 'article', a.gid]);
      articleByGid[a.gid] = Array.isArray(data) ? data[0] : data;
    } catch (e) {
      const msg = String(e.message || e).slice(0, 200);
      log(`    FAIL: ${msg}`);
      articleByGid[a.gid] = { __error: msg };
    }
  }
}

// Collect all image URLs, grouped by their source article gid (for screenshot fallback).
const allImages = new Set();
const urlsByGid = new Map();   // gid -> Set<url>
function addImg(gid, url) {
  if (!url) return;
  allImages.add(url);
  if (!urlsByGid.has(gid)) urlsByGid.set(gid, new Set());
  urlsByGid.get(gid).add(url);
}
for (const topic of hot) {
  for (const a of topic.articles || []) {
    addImg(a.gid, a.coverUrl);
    const full = articleByGid[a.gid];
    if (full && !full.__error) {
      addImg(a.gid, full.coverUrl);
      for (const u of full.coverUrls || []) addImg(a.gid, u);
      for (const e of full.inlineImages || []) addImg(a.gid, e.src);
    }
  }
}

// ---------- 3a. Pass 1: Node concurrent download (fast path) ----------
const urls = [...allImages];
log(`3/4 (pass 1) Node-downloading ${urls.length} images (concurrency 6)...`);
const localOf = {};
const pass1Results = await withConcurrency(urls, 6, async (url) => downloadImageNode(url));
let pass1Ok = 0, pass1Fail = 0;
for (let i = 0; i < urls.length; i++) {
  const r = pass1Results[i];
  if (r && typeof r === 'string') { localOf[urls[i]] = `images/${r}`; pass1Ok++; }
  else { pass1Fail++; }
}
log(`  pass 1: ${pass1Ok} ok / ${pass1Fail} fail`);

// ---------- 3b. Pass 2: Screenshot fallback for failed URLs ----------
// Strategy: for each article gid, open /article/<gid> (Chrome loads images natively),
// then for each failed URL, isolate the matching <img> via DOM tweaks and screenshot at natural size.
const failedUrls = urls.filter((u) => !localOf[u]);
if (failedUrls.length > 0) {
  log(`3/4 (pass 2) screenshotting ${failedUrls.length} images via Chrome...`);

  // Build: which article gids own the failed urls
  const gidsToProcess = new Set();
  for (const [gid, urlSet] of urlsByGid) {
    for (const u of urlSet) {
      if (!localOf[u]) { gidsToProcess.add(gid); break; }
    }
  }

  let ssOk = 0, ssFail = 0;
  for (const gid of gidsToProcess) {
    const failedHere = [...urlsByGid.get(gid)].filter((u) => !localOf[u]);
    if (!failedHere.length) continue;
    const article = articleByGid[gid];
    if (!article || article.__error) {
      log(`  rank gid=${gid}: skip, article error`);
      continue;
    }

    const articleUrl = article.url || `https://www.dongchedi.com/article/${gid}`;
    log(`  open ${gid} (${failedHere.length} imgs needed)`);

    try {
      await browserOpen(articleUrl);
    } catch (e) {
      log(`    open fail: ${String(e.message || e).slice(0, 120)}`);
      continue;
    }

    // Give Chrome a moment for images to load
    await sleep(3500);

    // Find all loaded <img> elements with their natural sizes + identities
    let imgs;
    try {
      imgs = await browserEval(`(() => {
        const arr = [...document.querySelectorAll('img')];
        return arr.map((img, idx) => {
          const src = img.src || '';
          const m = src.match(/byteimg\\.com\\/([^?]+?)(?:~|\\?|$)/);
          return {
            idx,
            srcId: m ? m[1] : src,
            complete: img.complete,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
          };
        }).filter(i => i.complete && i.naturalWidth > 1);
      })()`);
    } catch (e) {
      log(`    eval fail: ${String(e.message || e).slice(0, 120)}`);
      continue;
    }

    for (const url of failedHere) {
      const id = urlIdentity(url);
      const match = imgs.find((m) => m.srcId === id);
      if (!match) continue;

      // Isolate: move target <img> to top of body, fixed position, natural size; hide siblings
      try {
        const iso = await browserEval(`(() => {
          const orig = document.querySelectorAll('img')[${match.idx}];
          if (!orig) return { error: 'gone' };
          const w = orig.naturalWidth, h = orig.naturalHeight;
          if (!w || !h) return { error: 'not-loaded' };
          window.__ss_state = {
            orig,
            parent: orig.parentNode,
            next: orig.nextSibling,
            bodyChildren: [...document.body.children].map(el => [el, el.style.cssText]),
            bodyStyle: document.body.style.cssText,
            htmlStyle: document.documentElement.style.cssText,
          };
          // Hide all direct body children
          [...document.body.children].forEach(el => { el.style.visibility = 'hidden'; });
          // Move target to body
          document.body.prepend(orig);
          orig.style.cssText = 'position:fixed;top:0;left:0;width:' + w + 'px;height:' + h + 'px;background:#fff;display:block;z-index:2147483647;visibility:visible;margin:0;padding:0';
          document.body.style.cssText = 'margin:0;padding:0;background:#fff;overflow:hidden';
          document.documentElement.style.cssText = 'margin:0;padding:0;background:#fff;overflow:hidden';
          window.scrollTo(0, 0);
          return { w, h };
        })()`);

        if (iso?.error) {
          ssFail++;
          continue;
        }

        const outPath = path.join(IMG_DIR, `${hashUrl(url)}.png`);
        await browserScreenshot(outPath, iso.w, iso.h);
        localOf[url] = `images/${hashUrl(url)}.png`;
        ssOk++;
      } catch (e) {
        ssFail++;
        log(`    ss fail (${id.slice(-24)}): ${String(e.message || e).slice(0, 80)}`);
      } finally {
        // Restore page state so next isolate can find DOM
        try {
          await browserEval(`(() => {
            const s = window.__ss_state;
            if (!s) return { ok: false };
            try {
              s.orig.style.cssText = '';
              if (s.next && s.next.parentNode) s.parent.insertBefore(s.orig, s.next);
              else s.parent.appendChild(s.orig);
            } catch (e) {}
            for (const [el, css] of s.bodyChildren || []) { try { el.style.cssText = css; } catch (e) {} }
            document.body.style.cssText = s.bodyStyle || '';
            document.documentElement.style.cssText = s.htmlStyle || '';
            window.__ss_state = null;
            return { ok: true };
          })()`);
        } catch (e) {
          // If restore fails, reload as last resort
          try { await browserOpen(articleUrl); await sleep(2500); } catch {}
        }
      }
    }
  }
  log(`  pass 2: ${ssOk} ok / ${ssFail} fail`);
}

const totalOk = Object.keys(localOf).length;
const totalFail = urls.length - totalOk;
log(`  total: ${totalOk} ok / ${totalFail} fail of ${urls.length}`);

// ---------- 4. Build state.json ----------
const mapImg = (url) => (url && localOf[url]) ? localOf[url] : null;

const state = {
  fetchedAt: new Date().toISOString(),
  outputDir: OUT_ROOT,
  imageStats: { total: urls.length, ok: totalOk, failed: totalFail },
  topics: hot.map((topic) => ({
    rank: topic.rank,
    title: topic.title,
    score: topic.score,
    isHot: topic.isHot,
    searchUrl: topic.searchUrl,
    sources: (topic.articles || []).map((preview) => {
      const full = articleByGid[preview.gid];
      if (!full || full.__error) {
        const previewLocal = preview.coverUrl ? mapImg(preview.coverUrl) : null;
        return {
          gid: preview.gid,
          title: preview.title || null,
          author: preview.author || null,
          pubTime: preview.pubTime || null,
          isVideo: preview.isVideo,
          abstract: preview.abstract || null,
          url: preview.url,
          coverImages: previewLocal ? [{ path: previewLocal, caption: null }] : [],
          inlineImages: [],
          text: '',
          error: full?.__error || 'article fetch failed',
        };
      }
      const coverImages = [];
      for (const u of full.coverUrls || []) {
        const local = mapImg(u);
        if (local && !coverImages.find((c) => c.path === local)) coverImages.push({ path: local, caption: null });
      }
      const previewCover = mapImg(preview.coverUrl);
      if (previewCover && !coverImages.find((c) => c.path === previewCover)) coverImages.push({ path: previewCover, caption: null });

      const inlineImages = [];
      const usedPaths = new Set(coverImages.map((c) => c.path));
      for (const e of full.inlineImages || []) {
        const local = mapImg(e.src);
        if (local && !usedPaths.has(local)) {
          inlineImages.push({ path: local, caption: e.caption || null });
          usedPaths.add(local);
        }
      }

      return {
        gid: full.gid || preview.gid,
        title: full.title || preview.title,
        author: full.author || preview.author || null,
        authorId: full.authorId || null,
        pubTime: full.pubTime || preview.pubTime || null,
        isVideo: !!full.isVideo,
        duration: full.duration ?? preview.duration ?? null,
        abstract: preview.abstract || null,
        text: full.text || '',
        url: full.url || preview.url,
        coverImages,
        inlineImages,
        stats: full.stats || null,
      };
    }),
  })),
};

writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');

const failedTopics = state.topics.filter((t) => t.sources.every((s) => s.error));
const partialTopics = state.topics.filter((t) => t.sources.some((s) => s.error) && !t.sources.every((s) => s.error));
log(`✅ wrote state.json — ${state.topics.length} topics; ${partialTopics.length} partial (1 source failed); ${failedTopics.length} fully failed`);
log(`   output dir: ${OUT_ROOT}`);
