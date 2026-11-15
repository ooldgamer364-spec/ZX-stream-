import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  absUrl,
  base64ToBytes,
  htmlText,
  prioritizeVideoSources,
  unpackJs,
  type ZangetsuVideoSource,
} from '../zangetsuRuntime';

interface MockResponse {
  status?: number;
  ok?: boolean;
  body?: string;
  headers?: Record<string, string>;
  url?: string;
}

function createAnimeDubHindiContext(routes: Record<string, MockResponse | ((url: string, opts?: any) => MockResponse)>) {
  const code = fs.readFileSync(
    path.resolve(process.cwd(), 'src/runtime/providers/animedubhindi.js'),
    'utf8'
  );

  const mockFetch = async (url: string, opts: any = {}) => {
    const cleanUrl = String(url || '').split('?aniyomi_')[0];
    const handler = routes[url] || routes[cleanUrl];
    if (handler) {
      const res = typeof handler === 'function' ? handler(url, opts) : handler;
      return {
        status: res.status ?? 200,
        ok: res.ok ?? true,
        body: res.body ?? '',
        headers: res.headers ?? {},
        url: res.url ?? url,
      };
    }
    return { status: 404, ok: false, body: '', headers: {}, url };
  };

  const sandbox: Record<string, unknown> = {
    __SOURCE_ID: 'animedubhindi',
    fetch: mockFetch,
    base64ToBytes,
    htmlText,
    absUrl,
    unpackJs,
    atob: (s: string) => Buffer.from(String(s || ''), 'base64').toString('binary'),
    btoa: (s: string) => Buffer.from(String(s || ''), 'binary').toString('base64'),
    console,
    setTimeout,
    clearTimeout,
    URL,
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(code, ctx, { filename: 'animedubhindi.js', timeout: 5000 });
  return ctx as any;
}

const HOME_HTML = `
<html><body>
  <article class="post-101">
    <img data-src="/wp-content/uploads/naruto.jpg" alt="Naruto Poster" />
    <h2><a href="https://www.animedubhindi.link/naruto-hindi-dub-download/">Naruto Hindi Dubbed Episodes Download</a></h2>
  </article>
  <article class="post-102">
    <img src="https://cdn.example.com/movie.jpg" />
    <h2><a href="/doraemon-movie-2026-download/">Doraemon Movie 2026 WEB-DL Movie Download</a></h2>
  </article>
</body></html>
`;

const DETAIL_HTML = `
<html>
<head>
  <meta property="og:title" content="Naruto Episodes Download" />
  <meta property="og:image" content="https://www.animedubhindi.link/og-naruto.jpg" />
</head>
<body>
  <div class="entry-content">
    <p>Young ninja seeks recognition from his village.</p>
    <img src="https://www.animedubhindi.link/poster-naruto.jpg" />
    <ul class="wp-block-list">
      <li><strong>Title:</strong> Naruto (2002)</li>
      <li><strong>MAL Rating:</strong> 8.3/10</li>
      <li><strong>Genres:</strong> Action | Adventure | Shounen</li>
      <li><strong>Audio Tracks:</strong> Hindi | Tamil | Telugu | Japanese</li>
    </ul>
    <div class="wp-block-button">
      <a href="https://new.adhlinks.com/episode/naruto-hindi/">Download / Watch</a>
    </div>
  </div>
</body>
</html>
`;

const LINKS_SERIES_HTML = `
<html><body>
  <div class="wp-block-group">
    <h2>Episode: 01</h2>
    <h4>
      480P x264 [Size: 110 MB]<br>
      <a href="https://hubcloud.pw/drive/ep1_480">Hcloud</a> |
      <a href="/redirect.php?data=abc">MEGA</a><br><br>
      720P HEVC [Size: 195 MB]<br>
      <a href="https://gdflix.vip/file/ep1_720">GDF</a> |
      <a href="https://gdtot.dad/file/ext1">GDTOT</a>
    </h4>
  </div>
  <div class="wp-block-group">
    <h2>Episode: 02</h2>
    <h4>
      1080P x264 [Size: 420 MB]<br>
      <a href="https://pixeldrain.com/u/pxlep2">PixelDrain</a>
    </h4>
  </div>
</body></html>
`;

test('AnimeDubHindi getInfo, getHome, search, and getDetail extract catalog and episodes cleanly', async () => {
  const ctx = createAnimeDubHindiContext({
    'https://www.animedubhindi.link/': { body: HOME_HTML },
    'https://www.animedubhindi.link/category/series/': { body: HOME_HTML },
    'https://www.animedubhindi.link/category/movie/': { body: HOME_HTML },
    'https://www.animedubhindi.link/?s=Naruto': { body: HOME_HTML },
    'https://www.animedubhindi.link/naruto-hindi-dub-download/': { body: DETAIL_HTML },
    'https://new.adhlinks.com/episode/naruto-hindi/': { body: LINKS_SERIES_HTML },
  });

  const info = ctx.getInfo();
  assert.equal(info.name, 'AnimeDubHindi');
  assert.equal(info.type, 'anime');
  assert.equal(info.lang, 'hi');

  const rows = await ctx.getHome({});
  assert.equal(rows.length, 3);
  assert.equal(rows[0].items[0].title, 'Naruto Hindi Dubbed');
  assert.equal(rows[0].items[0].cover, 'https://www.animedubhindi.link/wp-content/uploads/naruto.jpg');
  assert.equal(rows[0].items[1].title, 'Doraemon Movie 2026');

  const searchItems = await ctx.search('Naruto', 1, {});
  assert.equal(searchItems.length, 2);

  const detail = await ctx.getDetail('https://www.animedubhindi.link/naruto-hindi-dub-download/', {});
  assert.equal(detail.title, 'Naruto (2002)');
  assert.equal(detail.year, '2002');
  assert.equal(detail.rating, '8.3');
  assert.deepEqual(Array.from(detail.genres), ['Action', 'Adventure', 'Shounen']);
  assert.ok(detail.description.includes('Audio: Hindi | Tamil | Telugu | Japanese'));
  assert.equal(detail.episodes.length, 2);
  assert.equal(detail.episodes[0].number, 1);
  assert.equal(detail.episodes[0].url, 'https://new.adhlinks.com/episode/naruto-hindi/?aniyomi_episode=1');
  assert.equal(detail.episodes[1].number, 2);
});

test('AnimeDubHindi resolves HubCloud, GDFlix, GoFile, PixelDrain, redirect.php and excludes external mirrors from direct playback', async () => {
  const ctx = createAnimeDubHindiContext({
    'https://www.animedubhindi.link/': { body: HOME_HTML },
    'https://new.adhlinks.com/episode/naruto-hindi/': { body: LINKS_SERIES_HTML },
    'https://hubcloud.pw/drive/ep1_480': {
      body: `<a id="download" href="https://gamerxyt.com/hubcloud.php?id=ep1_480">Download</a>`,
    },
    'https://gamerxyt.com/hubcloud.php?id=ep1_480': {
      body: `
        <div class="card-header">Naruto S01E01 480p WEB-DL x264 Hindi.mkv</div>
        <i id="size">110 MB</i>
        <a class="btn" href="https://r2.cloudflarestorage.com/hub/ep1.mkv">Download [FSL Server]</a>
        <a class="btn" href="https://fuckingfast.net/buzz1">Download [BuzzServer]</a>
        <a class="btn" href="https://pixeldrain.dev/u/decoy">Download [PixelServer]</a>
        <script>var pxl = "https://pixeldrain.dev/u/realpxl";</script>
      `,
    },
    'https://fuckingfast.net/buzz1/download': {
      status: 302,
      headers: { 'hx-redirect': 'https://cdn.fuckingfast.net/direct/ep1_480.mp4' },
    },
    'https://new.adhlinks.com/redirect.php?data=abc': {
      status: 302,
      headers: { location: 'https://mega.nz/file/megaep1' },
    },
    'https://gdflix.vip/file/ep1_720': {
      body: `
        <ul>
          <li class="list-group-item">Name : Naruto S01E01 720p HEVC Multi.mkv</li>
          <li class="list-group-item">Size : 195 MB</li>
        </ul>
        <a href="https://busycdn.instadl.rest/stream/ep1_720.mkv">Instant DL [10GBPS]</a>
        <a href="https://gofile.io/d/go123">GoFile</a>
      `,
    },
    'https://api.gofile.io/accounts': {
      body: JSON.stringify({ status: 'ok', data: { token: 'tok_test_123' } }),
    },
    'https://gofile.io/dist/js/global.js': {
      body: `appdata.wt = "wt_test_999";`,
    },
    'https://api.gofile.io/contents/go123?wt=wt_test_999': (_url, opts) => {
      assert.equal(opts.headers.Authorization, 'Bearer tok_test_123');
      return {
        body: JSON.stringify({
          data: {
            children: {
              f1: {
                name: 'Naruto.E01.720p.Hindi.mkv',
                link: 'https://store1.gofile.io/download/web/Naruto.E01.720p.Hindi.mkv',
                size: 204472320,
              },
            },
          },
        }),
      };
    },
  });

  const rawSources: ZangetsuVideoSource[] = await ctx.getVideoSources(
    'https://new.adhlinks.com/episode/naruto-hindi/?aniyomi_episode=1',
    {}
  );

  // Verify external links are explicitly marked non-playable
  const gdtot = rawSources.find((s) => s.url.includes('gdtot'));
  const mega = rawSources.find((s) => s.url.includes('mega.nz'));
  assert.equal(gdtot?.isDirectPlayable, false);
  assert.equal(mega?.isDirectPlayable, false);

  // Verify direct hosts are resolved cleanly with exact quality/size/headers
  const fsl = rawSources.find((s) => s.url.includes('r2.cloudflarestorage.com'));
  assert.equal(fsl?.quality, '480p');
  assert.ok(fsl?.label.includes('[HubCloud FSL]'));

  const buzz = rawSources.find((s) => s.url.includes('cdn.fuckingfast.net'));
  assert.equal(buzz?.quality, '480p');

  const pxl = rawSources.find((s) => s.url.includes('pixeldrain.dev/api/file/realpxl?download'));
  assert.ok(pxl);

  const gdflixInst = rawSources.find((s) => s.url.includes('busycdn.instadl.rest'));
  assert.equal(gdflixInst?.quality, '720p');
  assert.ok(gdflixInst?.label.includes('[195 MB]'));

  const gofile = rawSources.find((s) => s.url.includes('gofile.io/download'));
  assert.equal(gofile?.headers?.Cookie, 'accountToken=tok_test_123');
  assert.equal(gofile?.quality, '720p');

  // Verify prioritizeVideoSources strips all external-only links so player only receives real streams
  const playable = prioritizeVideoSources(rawSources);
  assert.equal(playable.some((s) => s.url.includes('gdtot') || s.url.includes('mega.nz')), false);
  assert.equal(playable.length, 5);
});
