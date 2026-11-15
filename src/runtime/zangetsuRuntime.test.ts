import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base64ToBytes,
  htmlText,
  absUrl,
  unpackJs,
  enrichVideoSource,
  prioritizeVideoSources,
  normalizeMediaTitle,
  getFailoverProviders,
  pickBestCatalogMatch,
  type ZangetsuVideoSource,
  type ZangetsuCatalogItem,
} from './zangetsuRuntime';

test('base64ToBytes decodes base64 string into byte array accurately', () => {
  const bytes = base64ToBytes('SGVsbG8=');
  assert.deepEqual(bytes, [72, 101, 108, 108, 111]);
});

test('htmlText strips tags and decodes HTML entities cleanly', () => {
  const raw = '<div><span class="material-icons">movie</span> Download &amp; Watch &#039;Avengers: Endgame&#039; (2026) &ndash; 1080p</div>';
  assert.equal(htmlText(raw), "movie Download & Watch 'Avengers: Endgame' (2026) – 1080p");
});

test('absUrl resolves relative paths against base domain', () => {
  assert.equal(absUrl('/category/hindi-dubbed/', 'https://new5.hdhub4u.cl'), 'https://new5.hdhub4u.cl/category/hindi-dubbed/');
  assert.equal(absUrl('https://pixeldrain.dev/api/file/abc', 'https://new5.hdhub4u.cl'), 'https://pixeldrain.dev/api/file/abc');
});

test('unpackJs unpacks Dean Edwards packed JS payloads', () => {
  const packed = "eval(function(p,a,c,k,e,d){e=function(c){return c};if(!''.replace(/^/,String)){while(c--){d[c]=k[c]||c}k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('0=\"1://2.3/4.5\"',6,6,'file|https|cdn|example|master|m3u8'.split('|'),0,{}))";
  const unpacked = unpackJs(packed);
  assert.equal(unpacked.includes('https://cdn.example/master.m3u8'), true);
});

test('enrichVideoSource extracts server, codec, audioFormat, size and playability', () => {
  const raw: ZangetsuVideoSource = {
    url: 'https://8330eb.r2.cloudflarestorage.com/hub/movie.mkv',
    quality: '1080p',
    container: 'mp4',
    label: 'HDHub4u [FSL Server] [WEB-DL H264 DDP5.1 DUAL] [2.45 GB] 1080p',
  };
  const enriched = enrichVideoSource(raw);
  assert.equal(enriched.server, 'FSL Server');
  assert.equal(enriched.codec, 'AVC / H.264');
  assert.equal(enriched.audioFormat, 'Dolby Digital+ 5.1');
  assert.equal(enriched.size, '2.45 GB');
  assert.equal(enriched.isDirectPlayable, true);
});

test('prioritizeVideoSources filters out non-streamable redirect pages and ranks R2/HLS first', () => {
  const list: ZangetsuVideoSource[] = [
    {
      url: 'https://hubcloud.pw/tg/go?id=abc',
      quality: '1080p',
      container: 'mp4',
      label: 'HDHub4u [Download] [WEB-DL X264] [1.5 GB] 1080p',
    },
    {
      url: 'https://pixeldrain.dev/api/file/xyz?download',
      quality: '720p',
      container: 'mp4',
      label: 'HDHub4u [Pixeldrain] [WEB-DL H265 HINDI] [900 MB] 720p',
    },
    {
      url: 'https://8330eb.r2.cloudflarestorage.com/hub/file.mkv',
      quality: '1080p',
      container: 'mp4',
      label: 'HDHub4u [FSL Server] [WEB-DL X264 HINDI] [1.8 GB] 1080p',
    },
  ];
  const sorted = prioritizeVideoSources(list);
  assert.equal(sorted.length, 2);
  assert.equal(sorted[0].server, 'FSL Server');
  assert.equal(sorted[1].server, 'Pixeldrain');
});

test('prioritizeVideoSources excludes external-only mirrors even if unmarked', () => {
  const list: ZangetsuVideoSource[] = [
    {
      url: 'https://gdtot.dad/file/abc123',
      quality: '1080p',
      container: 'mp4',
      label: 'AnimeDubHindi [GDTOT (External)] 1080p',
    },
    {
      url: 'https://mega.nz/file/xyz',
      quality: '720p',
      container: 'mp4',
      label: 'AnimeDubHindi [MEGA (External)] 720p',
    },
    {
      url: 'https://desidubanime.me/watch/123',
      quality: 'auto',
      container: 'mp4',
      label: 'AnimeDubHindi [Watch Online (External)]',
      isDirectPlayable: false,
    },
    {
      url: 'https://pixeldrain.com/api/file/real123?download',
      quality: '720p',
      container: 'mp4',
      label: 'AnimeDubHindi [Pixeldrain] [186 MB] 720p',
    },
  ];
  const sorted = prioritizeVideoSources(list);
  assert.equal(sorted.length, 1);
  assert.equal(sorted[0].url, 'https://pixeldrain.com/api/file/real123?download');
});

test('getFailoverProviders returns alternative anime and movie providers in priority order', () => {
  assert.deepEqual(getFailoverProviders('hianime', 'anime'), ['anikoto', 'animecube', 'kartoons', 'animedubhindi']);
  assert.deepEqual(getFailoverProviders('anikoto', 'anime'), ['hianime', 'animecube', 'kartoons', 'animedubhindi']);
  assert.deepEqual(getFailoverProviders('animedubhindi', 'anime'), ['hianime', 'anikoto', 'animecube', 'kartoons']);
  assert.deepEqual(getFailoverProviders('hdhub4u', 'movie'), ['fourkhdhub', 'uhdmovies']);
});

test('pickBestCatalogMatch selects the closest matching title across providers', () => {
  const candidates: ZangetsuCatalogItem[] = [
    { id: '1', title: 'Random Action Show', cover: null, url: '/random', type: 'anime', sourceId: 'anikoto' },
    { id: '2', title: 'Black Clover Season 2', cover: null, url: '/black-clover-2', type: 'anime', sourceId: 'anikoto' },
  ];
  const match = pickBestCatalogMatch('Black Clover: Season 2 (TV)', candidates);
  assert.equal(match?.id, '2');
  assert.equal(normalizeMediaTitle('Black Clover Season 2'), 'black clover');
});
