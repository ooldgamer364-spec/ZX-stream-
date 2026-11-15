// AnimeDubHindi — Hindi/Multi-Audio anime source for the Zangetsu runtime.
// Ported faithfully from AnimeDubHindi.kt (Aniyomi) into Zangetsu's ES5 VM contract.
// Uses only existing Zangetsu sandbox globals: __SOURCE_ID, fetch, htmlText, absUrl, URL.

var SOURCE_ID = (typeof __SOURCE_ID !== 'undefined' && __SOURCE_ID)
  ? String(__SOURCE_ID)
  : 'animedubhindi';

var PRIMARY_SITE = 'https://www.animedubhindi.link';
var MIRROR_SITES = [
  'https://www.animedubhindi.link',
  'https://www.animedubhindi.top',
  'https://animedubhindi.org'
];

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

var GOFILE_URL = 'https://gofile.io';
var GOFILE_API = 'https://api.gofile.io';
var EPISODE_QUERY = 'aniyomi_episode';
var SECTION_QUERY = 'aniyomi_section';

var _cachedSite = null;

function getInfo() {
  return {
    name: 'AnimeDubHindi',
    lang: 'hi',
    baseUrl: _cachedSite || PRIMARY_SITE,
    logo: (_cachedSite || PRIMARY_SITE) + '/favicon.ico',
    type: 'anime',
    version: '1.0.0'
  };
}

// ── String & URL Utilities ──────────────────────────────────────────────────

function _trim(s) {
  return String(s == null ? '' : s).replace(/^\s+|\s+$/g, '');
}

function _uniq(arr) {
  var seen = {};
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] && !seen[arr[i]]) {
      seen[arr[i]] = 1;
      out.push(arr[i]);
    }
  }
  return out;
}

function _cleanTitle(raw) {
  var t = htmlText(raw || '');
  t = t.replace(/\s*(WEB-DL|BluRay|CR Dub)?\s*(Episodes?|Movie)?\s*Download.*$/i, '');
  t = t.replace(/\s+/g, ' ');
  return _trim(t) || _trim(htmlText(raw || ''));
}

function _cleanEpisodeName(raw) {
  return _trim(htmlText(raw || '').replace(/\s+/g, ' '));
}

function _episodeNumber(text) {
  var m = String(text || '').match(/Episode\s*:?\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function _qualityTag(text) {
  var m = String(text || '').match(/(\d{3,4}P?[^|\]\n<]*)/i);
  return m ? _trim(m[1]) : '';
}

function _normQuality(text) {
  var s = String(text || '');
  if (/2160[pP]?|\b4K\b/i.test(s)) return '4K';
  var m = s.match(/(\d{3,4})[pP]/);
  if (m) return m[1] + 'p';
  return 'auto';
}

function _extractSize(text) {
  var m = String(text || '').match(/(?:Size\s*:\s*|\b)(\d+(?:\.\d+)?\s*(?:MB|GB|KB|TB))\b/i);
  return m ? m[1].replace(/\s+/g, ' ').toUpperCase() : '';
}

function _formatBytes(bytes) {
  var n = Number(bytes || 0);
  if (!isFinite(n) || n <= 0) return '';
  if (n < 1024 * 1024 * 1024) {
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function _baseOrigin(u) {
  try {
    var parsed = new URL(u);
    return parsed.protocol + '//' + parsed.host;
  } catch (e) {
    var m = String(u || '').match(/^(https?:\/\/[^/#?]+)/i);
    return m ? m[1] : '';
  }
}

function _fixUrl(raw, base) {
  var s = _trim(raw);
  if (!s) return '';
  if (s.indexOf('//') === 0) return 'https:' + s;
  if (/^https?:\/\//i.test(s)) return s;
  return absUrl(s, base || (_cachedSite || PRIMARY_SITE));
}

function _pageUrl(base, path, page) {
  var cleanBase = String(base || PRIMARY_SITE).replace(/\/$/, '');
  var cleanPath = String(path || '').replace(/^\/+|\/+$/g, '');
  var p = parseInt(page || 1, 10) || 1;
  if (p <= 1 && !cleanPath) return cleanBase + '/';
  if (p <= 1) return cleanBase + '/' + cleanPath + '/';
  if (!cleanPath) return cleanBase + '/page/' + p + '/';
  return cleanBase + '/' + cleanPath + '/page/' + p + '/';
}

function _searchUrl(base, query, page) {
  var cleanBase = String(base || PRIMARY_SITE).replace(/\/$/, '');
  var p = parseInt(page || 1, 10) || 1;
  var path = p <= 1 ? '/' : ('/page/' + p + '/');
  return cleanBase + path + '?s=' + encodeURIComponent(query || '');
}

function _withQueryParam(urlStr, key, val) {
  try {
    var u = new URL(urlStr);
    u.searchParams.set(key, String(val));
    return u.toString();
  } catch (e) {
    var sep = urlStr.indexOf('?') !== -1 ? '&' : '?';
    return urlStr + sep + encodeURIComponent(key) + '=' + encodeURIComponent(String(val));
  }
}

function _getQueryParam(urlStr, key) {
  try {
    var u = new URL(urlStr);
    return u.searchParams.get(key);
  } catch (e) {
    var m = String(urlStr || '').match(new RegExp('[?&]' + key + '=([^&#]+)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
}

function _decodeHtmlAttr(s) {
  return String(s || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function _isPlayableHost(href) {
  var l = String(href || '').toLowerCase();
  return l.indexOf('hubcloud') !== -1 ||
    l.indexOf('gdflix') !== -1 ||
    l.indexOf('gofile') !== -1 ||
    l.indexOf('pixeldrain') !== -1 ||
    l.indexOf('pixeldra') !== -1 ||
    l.indexOf('gdtot') !== -1 ||
    l.indexOf('gdmirrorbot') !== -1 ||
    l.indexOf('terabox') !== -1 ||
    l.indexOf('1024tera') !== -1 ||
    l.indexOf('mega.nz') !== -1 ||
    l.indexOf('desidubanime') !== -1 ||
    l.indexOf('r2.dev') !== -1 ||
    l.indexOf('r2.cloudflarestorage') !== -1 ||
    l.indexOf('busycdn') !== -1 ||
    l.indexOf('indexserver') !== -1 ||
    l.indexOf('redirect.php') !== -1 ||
    l.indexOf('re.php') !== -1 ||
    l.indexOf('fpgo.') !== -1 ||
    l.indexOf('filepress') !== -1 ||
    /\.(mkv|mp4|m3u8)(\?|$)/i.test(l);
}

function _isDirectVideoUrl(url) {
  return /\.(mkv|mp4|m3u8)(\?|$)/i.test(String(url || ''));
}

function _hasDownloadLink(anchors) {
  var labels = {
    mega: 1, gdtot: 1, multi: 1, tera: 1, hcloud: 1,
    gdf: 1, fprs: 1, 'click here': 1, hubcloud: 1, gdflix: 1
  };
  for (var i = 0; i < anchors.length; i++) {
    var a = anchors[i];
    if (_isPlayableHost(a.href)) return true;
    if (labels[String(a.text || '').toLowerCase()]) return true;
  }
  return false;
}

// ── Network Helpers ─────────────────────────────────────────────────────────

function _get(url, ref) {
  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Referer': ref || (_baseOrigin(url) + '/')
    }
  }).then(function (r) {
    return r && r.body ? r.body : '';
  }).catch(function () {
    return '';
  });
}

function _resolveSite() {
  if (_cachedSite) return Promise.resolve(_cachedSite);
  function tryIndex(idx) {
    if (idx >= MIRROR_SITES.length) {
      _cachedSite = PRIMARY_SITE;
      return Promise.resolve(_cachedSite);
    }
    var candidate = MIRROR_SITES[idx];
    return fetch(candidate + '/', {
      headers: { 'User-Agent': UA },
      timeoutMs: 8000
    }).then(function (r) {
      if (r && r.ok && r.body && /<article/i.test(r.body)) {
        _cachedSite = _baseOrigin(r.url || candidate) || candidate;
        return _cachedSite;
      }
      return tryIndex(idx + 1);
    }).catch(function () {
      return tryIndex(idx + 1);
    });
  }
  return tryIndex(0);
}

// ── HTML Extraction Helpers ─────────────────────────────────────────────────

function _extractTagAttribute(tag, attrName) {
  var re = new RegExp(attrName + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i');
  var m = String(tag || '').match(re);
  return m ? _decodeHtmlAttr(m[1] != null ? m[1] : (m[2] || '')) : '';
}

function _extractImageFromHtml(html, base) {
  var re = /<img\b[^>]*>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var tag = m[0];
    var src = _extractTagAttribute(tag, 'data-lazy-src') ||
      _extractTagAttribute(tag, 'data-src') ||
      _extractTagAttribute(tag, 'src') ||
      _extractTagAttribute(tag, 'content');
    if (src && !/^data:image\/svg/i.test(src)) {
      return _fixUrl(src, base);
    }
  }
  return null;
}

function _extractBalancedDivBlocks(html, className) {
  var blocks = [];
  var s = String(html || '');
  var openRe = new RegExp('<div\\b[^>]*class\\s*=\\s*["\'][^"\']*\\b' + className + '\\b[^"\']*["\'][^>]*>', 'gi');
  var m;
  while ((m = openRe.exec(s)) !== null) {
    var startIdx = m.index;
    var pos = openRe.lastIndex;
    var depth = 1;
    var tagRe = /<\/?div\b[^>]*>/gi;
    tagRe.lastIndex = pos;
    var tm;
    while ((tm = tagRe.exec(s)) !== null) {
      if (tm[0].indexOf('</') === 0) {
        depth -= 1;
        if (depth === 0) {
          blocks.push(s.slice(startIdx, tagRe.lastIndex));
          break;
        }
      } else {
        depth += 1;
      }
    }
  }
  return blocks;
}

function _extractAnchors(html, base) {
  var anchors = [];
  var re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(String(html || ''))) !== null) {
    var attrs = m[1];
    var rawHref = _extractTagAttribute(attrs, 'href');
    if (!rawHref || rawHref.charAt(0) === '#') continue;
    var href = _fixUrl(rawHref, base);
    var text = htmlText(m[2] || '');
    anchors.push({
      href: href,
      rawHref: rawHref,
      text: text,
      index: m.index,
      attrs: attrs
    });
  }
  return anchors;
}

function _parseListing(html, base) {
  var items = [];
  var seen = {};
  var re = /<article\b[\s\S]*?<\/article>/gi;
  var m;
  while ((m = re.exec(String(html || ''))) !== null) {
    var art = m[0];
    var hrefMatch = art.match(/<h2[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i) ||
      art.match(/<[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i) ||
      art.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!hrefMatch) continue;
    var url = _fixUrl(_decodeHtmlAttr(hrefMatch[1]), base);
    if (!url || seen[url]) continue;
    seen[url] = 1;

    var titleText = _cleanTitle(hrefMatch[2] || '');
    if (!titleText) {
      var altM = art.match(/<img\b[^>]*alt=["']([^"']+)["']/i);
      titleText = _cleanTitle(altM ? altM[1] : 'Untitled');
    }

    var cover = _extractImageFromHtml(art, base);
    items.push({
      id: url,
      title: titleText || 'Untitled',
      cover: cover,
      url: url,
      type: 'anime',
      sourceId: SOURCE_ID
    });
  }
  return items;
}

// ── Public Zangetsu Entrypoints: Home & Search ──────────────────────────────

function getHome(opts) {
  return _resolveSite().then(function (site) {
    var shelves = [
      { title: 'Latest Hindi Dubs', path: '' },
      { title: 'Popular Series', path: 'category/series' },
      { title: 'Anime Movies', path: 'category/movie' }
    ];
    return Promise.all(shelves.map(function (s) {
      return _get(_pageUrl(site, s.path, 1), site + '/').then(function (html) {
        return {
          title: s.title,
          items: _parseListing(html, site)
        };
      });
    })).then(function (rows) {
      return rows.filter(function (r) { return r && r.items && r.items.length > 0; });
    });
  });
}

function search(query, page, opts) {
  return _resolveSite().then(function (site) {
    var q = _trim(query || '');
    var p = parseInt(page || 1, 10) || 1;
    var targetUrl = !q
      ? _pageUrl(site, 'category/series', p)
      : _searchUrl(site, q, p);
    return _get(targetUrl, site + '/').then(function (html) {
      return _parseListing(html, site);
    });
  });
}

// ── Detail & Episode Extraction ─────────────────────────────────────────────

function _parseInfoMap(html) {
  var map = {};
  var ulMatch = String(html || '').match(/<ul\b[^>]*class=["'][^"']*wp-block-list[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i);
  if (!ulMatch) return map;
  var liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  var m;
  while ((m = liRe.exec(ulMatch[1])) !== null) {
    var text = htmlText(m[1]).replace(/\s+/g, ' ');
    var colon = text.indexOf(':');
    if (colon === -1) continue;
    var k = _trim(text.slice(0, colon));
    var v = _trim(text.slice(colon + 1));
    if (k && v) map[k] = v;
  }
  return map;
}

function _findLinksPages(html, base) {
  var pages = [];
  var btnBlocks = _extractBalancedDivBlocks(html, 'wp-block-button');
  for (var i = 0; i < btnBlocks.length; i++) {
    var anchors = _extractAnchors(btnBlocks[i], base);
    for (var j = 0; j < anchors.length; j++) {
      var u = anchors[j].href;
      if (/links\.animedubhindi|adhlinks\./i.test(u)) {
        pages.push(u);
      }
    }
  }
  return _uniq(pages);
}

function _parseLinksPageEpisodes(linksPage) {
  return _get(linksPage, linksPage).then(function (html) {
    if (!html) return [];
    var episodes = [];
    var seenUrl = {};

    var groups = _extractBalancedDivBlocks(html, 'wp-block-group');
    for (var i = 0; i < groups.length; i++) {
      var grp = groups[i];
      var anchors = _extractAnchors(grp, linksPage);
      if (!_hasDownloadLink(anchors)) continue;
      var plain = htmlText(grp);
      var epNum = _episodeNumber(plain);
      if (epNum != null) {
        var epUrl = _withQueryParam(linksPage, EPISODE_QUERY, epNum);
        if (!seenUrl[epUrl]) {
          seenUrl[epUrl] = 1;
          episodes.push({
            id: 'ep-' + epNum,
            number: epNum,
            title: 'Episode ' + epNum,
            url: epUrl
          });
        }
      } else if (episodes.length === 0) {
        var hMatch = grp.match(/<h[234]\b[^>]*>([\s\S]*?)<\/h[234]>/i);
        var label = _cleanEpisodeName(hMatch ? hMatch[1] : '') || 'Movie';
        var secUrl = _withQueryParam(linksPage, SECTION_QUERY, i);
        if (!seenUrl[secUrl]) {
          seenUrl[secUrl] = 1;
          episodes.push({
            id: 'sec-' + i,
            number: i + 1,
            title: label,
            url: secUrl
          });
        }
      }
    }

    var cards = _extractBalancedDivBlocks(html, 'pro-ep-card');
    for (var j = 0; j < cards.length; j++) {
      var card = cards[j];
      var cAnchors = _extractAnchors(card, linksPage);
      if (!_hasDownloadLink(cAnchors)) continue;
      var titleMatch = card.match(/<[^>]*class=["'][^"']*pro-ep-title[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
      var rawTitle = titleMatch ? htmlText(titleMatch[1]) : '';
      var cEpNum = _episodeNumber(rawTitle) || (j + 1);
      var cUrl = _withQueryParam(linksPage, EPISODE_QUERY, cEpNum);
      if (!seenUrl[cUrl]) {
        seenUrl[cUrl] = 1;
        episodes.push({
          id: 'ep-' + cEpNum,
          number: cEpNum,
          title: _cleanEpisodeName(rawTitle) || ('Episode ' + cEpNum),
          url: cUrl
        });
      }
    }

    return episodes;
  });
}

function getDetail(url, opts) {
  return _resolveSite().then(function (site) {
    var targetUrl = _fixUrl(url, site);
    return _get(targetUrl, site + '/').then(function (html) {
      var info = _parseInfoMap(html);
      var ogTitleM = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
      var title = _cleanTitle(info['Title'] || (ogTitleM ? _decodeHtmlAttr(ogTitleM[1]) : '') || 'Untitled');

      var contentBlock = (html.match(/<div[^>]*class=["'][^"']*entry-content[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?:<footer|<\/article)/i) || [])[1] || html;
      var poster = _extractImageFromHtml(contentBlock, site);
      if (!poster) {
        var ogImgM = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
          html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
        poster = ogImgM ? _fixUrl(_decodeHtmlAttr(ogImgM[1]), site) : null;
      }

      var firstP = contentBlock.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
      var descBase = _trim(htmlText(firstP ? firstP[1] : ''));
      var audioTracks = info['Audio Tracks'] || info['Audio Tracks '] || '';
      var description = descBase + (audioTracks ? (descBase ? '\n' : '') + 'Audio: ' + audioTracks : '');

      var genresRaw = info['Genres'] || '';
      var genres = genresRaw
        ? genresRaw.split(/[|,]/).map(_trim).filter(Boolean)
        : [];

      var ratingRaw = info['MAL Rating'] || '';
      var ratingMatch = ratingRaw.match(/(\d+(?:\.\d+)?)/);
      var rating = ratingMatch ? ratingMatch[1] : null;

      var yearMatch = (info['Title'] || htmlText(ogTitleM ? ogTitleM[1] : '') || targetUrl).match(/\b(19|20)\d{2}\b/);
      var year = yearMatch ? yearMatch[0] : null;

      var linksPages = _findLinksPages(html, targetUrl);
      return Promise.all(linksPages.map(_parseLinksPageEpisodes)).then(function (epLists) {
        var episodes = [];
        var seenEpUrl = {};
        for (var i = 0; i < epLists.length; i++) {
          var arr = epLists[i] || [];
          for (var j = 0; j < arr.length; j++) {
            if (!seenEpUrl[arr[j].url]) {
              seenEpUrl[arr[j].url] = 1;
              episodes.push(arr[j]);
            }
          }
        }

        if (episodes.length === 0 && linksPages.length > 0) {
          for (var k = 0; k < linksPages.length; k++) {
            episodes.push({
              id: 'movie-' + (k + 1),
              number: k + 1,
              title: linksPages.length === 1 ? 'Movie' : ('Movie ' + (k + 1)),
              url: linksPages[k]
            });
          }
        }

        episodes.sort(function (a, b) { return a.number - b.number; });

        var hasHindi = /hindi/i.test(audioTracks || title);
        return {
          id: targetUrl,
          title: title,
          cover: poster,
          url: targetUrl,
          description: description,
          status: 'unknown',
          genres: genres,
          studios: [],
          type: 'anime',
          sourceId: SOURCE_ID,
          episodes: episodes,
          year: year,
          rating: rating,
          subCount: episodes.length,
          dubCount: hasHindi ? episodes.length : 0,
          audioTracks: audioTracks
        };
      });
    });
  });
}

function getEpisodes(url, opts) {
  return getDetail(url, opts).then(function (d) {
    return d.episodes || [];
  });
}

// ── Video Link & Host Extractors ────────────────────────────────────────────

function _makeSource(url, qualityRaw, serverName, opts) {
  var o = opts || {};
  var q = _normQuality(qualityRaw);
  var isHls = /\.m3u8(\?|$)/i.test(url);
  var tags = o.tags || '';
  var size = o.size || '';

  var label = 'AnimeDubHindi [' + serverName + ']';
  if (tags) label += ' [' + tags + ']';
  if (size) label += ' [' + size + ']';
  if (q && q !== 'auto') label += ' ' + q;

  var src = {
    url: url,
    quality: q,
    container: isHls ? 'hls' : 'mp4',
    headers: o.headers || { 'User-Agent': UA },
    kind: 'dub',
    audioLang: o.audioLang || 'hi',
    subtitles: [],
    label: label
  };
  if (o.isDirectPlayable === false) {
    src.isDirectPlayable = false;
  }
  return src;
}

function _extractDownloadItemsFromBlock(blockHtml, baseUrl) {
  var items = [];
  var wrappers = _extractBalancedDivBlocks(blockHtml, 'pro-quality-wrapper');
  if (wrappers.length > 0) {
    for (var w = 0; w < wrappers.length; w++) {
      var wrap = wrappers[w];
      var qMatch = wrap.match(/<[^>]*class=["'][^"']*pro-ep-quality[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
      var sMatch = wrap.match(/<[^>]*class=["'][^"']*pro-ep-size[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
      var quality = qMatch ? htmlText(qMatch[1]) : _qualityTag(htmlText(wrap));
      var size = sMatch ? _extractSize(htmlText(sMatch[1])) : _extractSize(htmlText(wrap));
      var wAnchors = _extractAnchors(wrap, baseUrl);
      for (var wa = 0; wa < wAnchors.length; wa++) {
        if (_isPlayableHost(wAnchors[wa].href)) {
          items.push({
            label: wAnchors[wa].text || 'Link',
            url: wAnchors[wa].href,
            quality: quality,
            size: size
          });
        }
      }
    }
    if (items.length > 0) return items;
  }

  // Handle WordPress h4 blocks (which may hold multiple quality tiers separated by <br> or headers)
  var h4Re = /<h4\b[^>]*>([\s\S]*?)<\/h4>/gi;
  var hm;
  while ((hm = h4Re.exec(blockHtml)) !== null) {
    var inner = hm[1];
    var hAnchors = _extractAnchors(inner, baseUrl);
    for (var ha = 0; ha < hAnchors.length; ha++) {
      var anc = hAnchors[ha];
      if (!_isPlayableHost(anc.href)) continue;
      // Look backwards from anchor to find its closest preceding quality/size line
      var prevSlice = inner.slice(0, anc.index);
      var segments = prevSlice.split(/<br\s*\/?>/i);
      var localQuality = '';
      var localSize = '';
      for (var si = segments.length - 1; si >= 0; si--) {
        var segText = htmlText(segments[si]);
        if (!segText) continue;
        if (!localSize) localSize = _extractSize(segText);
        if (!localQuality && /\d{3,4}[pP]/i.test(segText)) {
          localQuality = _qualityTag(segText);
          break;
        }
      }
      if (!localQuality) localQuality = _qualityTag(htmlText(inner));
      items.push({
        label: anc.text || 'Link',
        url: anc.href,
        quality: localQuality,
        size: localSize
      });
    }
  }

  if (items.length > 0) return items;

  // Fallback: all matching anchors inside the block
  var allAnchors = _extractAnchors(blockHtml, baseUrl);
  var blockQuality = _qualityTag(htmlText(blockHtml));
  var blockSize = _extractSize(htmlText(blockHtml));
  for (var ai = 0; ai < allAnchors.length; ai++) {
    if (_isPlayableHost(allAnchors[ai].href)) {
      items.push({
        label: allAnchors[ai].text || 'Link',
        url: allAnchors[ai].href,
        quality: blockQuality,
        size: blockSize
      });
    }
  }
  return items;
}

function _resolveRedirect(url) {
  var s = String(url || '');
  if (!/redirect\.php/i.test(s)) return Promise.resolve(s);
  return fetch(s, {
    headers: { 'User-Agent': UA, 'Referer': _baseOrigin(s) + '/' },
    followRedirects: false,
    timeoutMs: 10000
  }).then(function (r) {
    var h = (r && r.headers) || {};
    var loc = h['location'] || h['Location'];
    if (loc) return _fixUrl(loc, s);
    return (r && r.url) ? r.url : s;
  }).catch(function () {
    return s;
  });
}

function _pixelDrainVideos(url, quality, size, serverPrefix) {
  var m = String(url || '').match(/\/u\/([^/?#]+)/i);
  var origin = _baseOrigin(url) || 'https://pixeldrain.com';
  var fileUrl = m ? (origin + '/api/file/' + m[1] + '?download') : url;
  return [_makeSource(fileUrl, quality, (serverPrefix || '') + 'Pixeldrain', { size: size })];
}

function _goFileVideos(url, quality, serverPrefix) {
  var m = String(url || '').match(/\/(?:\?c=|d\/)([\da-zA-Z-]+)/);
  if (!m) return Promise.resolve([]);
  var contentId = m[1];

  return fetch(GOFILE_API + '/accounts', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: ''
  }).then(function (accRes) {
    var accJson = {};
    try { accJson = JSON.parse(accRes.body || '{}'); } catch (e) {}
    var token = accJson && accJson.data && accJson.data.token;
    if (!token) return [];

    return _get(GOFILE_URL + '/dist/js/global.js', GOFILE_URL + '/').then(function (globalJs) {
      var wtM = String(globalJs || '').match(/appdata\.wt\s*=\s*["']([^"']+)["']/);
      var wt = wtM ? wtM[1] : '4fd6sg89d7s6';
      return fetch(GOFILE_API + '/contents/' + contentId + '?wt=' + encodeURIComponent(wt), {
        headers: {
          'User-Agent': UA,
          'Authorization': 'Bearer ' + token
        }
      }).then(function (cRes) {
        var cJson = {};
        try { cJson = JSON.parse(cRes.body || '{}'); } catch (e) {}
        var children = (cJson && cJson.data && cJson.data.children) || {};
        var out = [];
        var keys = Object.keys(children);
        for (var i = 0; i < keys.length; i++) {
          var file = children[keys[i]];
          if (!file || !file.link) continue;
          var fileName = file.name || '';
          var fileQuality = _qualityTag(fileName) || quality;
          var fileSize = _formatBytes(file.size);
          out.push(_makeSource(file.link, fileQuality, (serverPrefix || '') + 'Gofile', {
            size: fileSize,
            tags: fileName,
            headers: {
              'User-Agent': UA,
              'Cookie': 'accountToken=' + token
            }
          }));
        }
        return out;
      });
    });
  }).catch(function () {
    return [];
  });
}

function _hubCloudVideos(url, fallbackQuality, fallbackSize) {
  var origin = _baseOrigin(url);
  var step1 = url.indexOf('hubcloud.php') !== -1
    ? Promise.resolve(url)
    : _get(url, origin + '/').then(function (html) {
        var dlM = String(html || '').match(/id=["']download["'][^>]*href=["']([^"']+)["']/i) ||
          String(html || '').match(/href=["']([^"']+)["'][^>]*id=["']download["']/i);
        return dlM ? _fixUrl(_decodeHtmlAttr(dlM[1]), origin) : url;
      });

  return step1.then(function (href) {
    if (!href) return [];
    return _get(href, origin + '/').then(function (doc) {
      if (!doc) return [];
      var sizeM = doc.match(/<i[^>]*id=["']size["'][^>]*>([\s\S]*?)<\/i>/i);
      var size = (sizeM ? _trim(htmlText(sizeM[1])) : '') || fallbackSize;
      var headerM = doc.match(/<div[^>]*class=["'][^"']*card-header[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
      var headerText = headerM ? htmlText(headerM[1]) : '';
      var quality = _qualityTag(headerText) || fallbackQuality;
      var pxlM = doc.match(/var\s+pxl\s*=\s*["']([^"']+)["']/);
      var pxlOverride = pxlM ? pxlM[1] : '';

      var btnRe = /<a\b[^>]*class=["'][^"']*\bbtn\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>|<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\bbtn\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
      var jobs = [];
      var bm;
      while ((bm = btnRe.exec(doc)) !== null) {
        var link = _fixUrl(_decodeHtmlAttr(bm[1] || bm[3]), href);
        var btnText = htmlText(bm[2] || bm[4] || '').toLowerCase();
        if (!link) continue;

        if (btnText.indexOf('download file') !== -1) {
          jobs.push(Promise.resolve(_makeSource(link, quality, 'HubCloud', { size: size, tags: headerText })));
        } else if (btnText.indexOf('fslv2') !== -1) {
          jobs.push(Promise.resolve(_makeSource(link, quality, 'HubCloud FSLv2', { size: size, tags: headerText })));
        } else if (btnText.indexOf('fsl server') !== -1) {
          jobs.push(Promise.resolve(_makeSource(link, quality, 'HubCloud FSL', { size: size, tags: headerText })));
        } else if (btnText.indexOf('s3 server') !== -1) {
          jobs.push(Promise.resolve(_makeSource(link, quality, 'HubCloud S3', { size: size, tags: headerText })));
        } else if (btnText.indexOf('pixeldra') !== -1 || btnText.indexOf('pixel') !== -1) {
          var realPxl = pxlOverride || link;
          var pBase = _baseOrigin(realPxl) || 'https://pixeldrain.com';
          var pUrl = realPxl.indexOf('download') !== -1
            ? realPxl
            : (pBase + '/api/file/' + realPxl.replace(/\/$/, '').split('/').pop() + '?download');
          jobs.push(Promise.resolve(_makeSource(pUrl, quality, 'HubCloud PixelDrain', { size: size, tags: headerText })));
        } else if (btnText.indexOf('buzzserver') !== -1) {
          (function (buzzLink) {
            jobs.push(fetch(buzzLink.replace(/\/$/, '') + '/download', {
              headers: { 'User-Agent': UA, 'Referer': buzzLink },
              followRedirects: false,
              timeoutMs: 10000
            }).then(function (br) {
              var h = (br && br.headers) || {};
              var redir = h['hx-redirect'] || h['HX-Redirect'] || h['location'] || h['Location'] || '';
              if (!redir) return null;
              return _makeSource(_fixUrl(redir, buzzLink), quality, 'HubCloud Buzz', { size: size, tags: headerText });
            }).catch(function () { return null; }));
          })(link);
        }
      }

      return Promise.all(jobs).then(function (resolved) {
        var out = [];
        for (var i = 0; i < resolved.length; i++) {
          if (resolved[i]) out.push(resolved[i]);
        }
        return out;
      });
    });
  }).catch(function () {
    return [];
  });
}

function _gdFlixVideos(url, fallbackQuality, fallbackSize) {
  return _get(url, _baseOrigin(url) + '/').then(function (doc) {
    if (!doc) return [];
    var nameM = doc.match(/<li[^>]*class=["'][^"']*list-group-item[^"']*["'][^>]*>[\s\S]*?Name\s*:([\s\S]*?)<\/li>/i);
    var fileName = nameM ? _trim(htmlText(nameM[1])) : '';
    if (!fileName) {
      var tM = doc.match(/<title>([\s\S]*?)<\/title>/i);
      fileName = tM ? _trim(htmlText(tM[1])) : '';
    }
    var sizeM = doc.match(/<li[^>]*class=["'][^"']*list-group-item[^"']*["'][^>]*>[\s\S]*?Size\s*:([\s\S]*?)<\/li>/i);
    var fileSize = (sizeM ? _trim(htmlText(sizeM[1])) : '') || fallbackSize;
    var quality = _qualityTag(fileName) || fallbackQuality;

    var anchors = _extractAnchors(doc, url);
    var jobs = [];
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var text = a.text || '';
      var lowerText = text.toLowerCase();
      var link = a.href;
      if (!link) continue;

      if (lowerText.indexOf('direct dl') !== -1 || lowerText.indexOf('direct server') !== -1) {
        jobs.push(Promise.resolve([_makeSource(link, quality, 'GDFlix Direct', { size: fileSize, tags: fileName })]));
      } else if (lowerText.indexOf('cloud download') !== -1) {
        var decoded = link;
        if (link.indexOf('url=') !== -1) {
          try {
            decoded = decodeURIComponent(link.split('url=')[1].split('&')[0]);
          } catch (e) {}
        }
        jobs.push(Promise.resolve([_makeSource(decoded, quality, 'GDFlix Cloud', { size: fileSize, tags: fileName })]));
      } else if (lowerText.indexOf('instant dl') !== -1) {
        if (/busycdn|r2\.dev|r2\.cloudflarestorage|\.(mp4|mkv|m3u8)(\?|$)/i.test(link)) {
          jobs.push(Promise.resolve([_makeSource(link, quality, 'GDFlix Instant', { size: fileSize, tags: fileName })]));
        } else {
          (function (instLink) {
            jobs.push(fetch(instLink, {
              headers: { 'User-Agent': UA, 'Referer': url },
              followRedirects: false,
              timeoutMs: 10000
            }).then(function (ir) {
              var h = (ir && ir.headers) || {};
              var loc = h['location'] || h['Location'] || '';
              var finalUrl = loc || instLink;
              if (finalUrl.indexOf('url=') !== -1) {
                try { finalUrl = decodeURIComponent(finalUrl.split('url=')[1].split('&')[0]); } catch (e) {}
              }
              return [_makeSource(_fixUrl(finalUrl, instLink), quality, 'GDFlix Instant', { size: fileSize, tags: fileName })];
            }).catch(function () { return []; }));
          })(link);
        }
      } else if (lowerText.indexOf('gofile') !== -1 && /gofile\.io/i.test(link)) {
        jobs.push(_goFileVideos(link, quality, 'GDFlix '));
      } else if (lowerText.indexOf('pixeldra') !== -1 || lowerText.indexOf('pixel') !== -1) {
        jobs.push(Promise.resolve(_pixelDrainVideos(link, quality, fileSize, 'GDFlix ')));
      }
    }

    return Promise.all(jobs).then(function (lists) {
      var out = [];
      for (var k = 0; k < lists.length; k++) {
        var arr = lists[k] || [];
        for (var j = 0; j < arr.length; j++) out.push(arr[j]);
      }
      return out;
    });
  }).catch(function () {
    return [];
  });
}

function _desiDubAnimeVideos(url, quality, size) {
  return _get(url, _baseOrigin(url) + '/').then(function (doc) {
    var watchA = _extractAnchors(doc, url).filter(function (a) {
      return a.href.indexOf('/watch/') !== -1;
    })[0];
    var watchUrl = watchA ? watchA.href : url;
    return _get(watchUrl, url).then(function (watchDoc) {
      var iframeM = String(watchDoc || '').match(/<iframe\b[^>]*src=["']([^"']+)["']/i);
      var target = iframeM ? _fixUrl(_decodeHtmlAttr(iframeM[1]), watchUrl) : watchUrl;
      var m3u8M = String(watchDoc || '').match(/(https?:\/\/[^"'\s]+\.(?:m3u8|mp4)[^"'\s]*)/i);
      if (m3u8M) {
        return [_makeSource(m3u8M[1], quality, 'DesiDubAnime', {
          size: size,
          headers: { 'User-Agent': UA, 'Referer': watchUrl }
        })];
      }
      // Do NOT classify an HTML watch/iframe page as a direct playable stream
      return [_makeSource(target, quality, 'Watch Online (External)', {
        size: size,
        isDirectPlayable: false
      })];
    });
  }).catch(function () {
    return [];
  });
}

function _extractVideosForItem(item) {
  return _resolveRedirect(item.url).then(function (resolvedUrl) {
    var lower = String(resolvedUrl || '').toLowerCase();
    var q = item.quality || '';
    var sz = item.size || '';

    if (lower.indexOf('gdflix') !== -1) {
      return _gdFlixVideos(resolvedUrl, q, sz);
    }
    if (lower.indexOf('gofile') !== -1) {
      return _goFileVideos(resolvedUrl, q, '');
    }
    if (lower.indexOf('pixeldrain') !== -1 || lower.indexOf('pixeldra') !== -1) {
      return _pixelDrainVideos(resolvedUrl, q, sz, '');
    }
    if (lower.indexOf('hubcloud') !== -1) {
      return _hubCloudVideos(resolvedUrl, q, sz).then(function (vids) {
        if (vids.length > 0) return vids;
        return [_makeSource(resolvedUrl, q, 'HubCloud (External)', { size: sz, isDirectPlayable: false })];
      });
    }
    if (lower.indexOf('gdtot') !== -1) {
      return [_makeSource(resolvedUrl, q, 'GDTOT (External)', { size: sz, isDirectPlayable: false })];
    }
    if (lower.indexOf('gdmirrorbot') !== -1) {
      return [_makeSource(resolvedUrl, q, 'Multi (External)', { size: sz, isDirectPlayable: false })];
    }
    if (lower.indexOf('terabox') !== -1 || lower.indexOf('1024tera') !== -1) {
      return [_makeSource(resolvedUrl, q, 'TeraBox (External)', { size: sz, isDirectPlayable: false })];
    }
    if (lower.indexOf('mega.nz') !== -1) {
      return [_makeSource(resolvedUrl, q, 'MEGA (External)', { size: sz, isDirectPlayable: false })];
    }
    if (lower.indexOf('desidubanime') !== -1) {
      return _desiDubAnimeVideos(resolvedUrl, q, sz);
    }
    if (_isDirectVideoUrl(lower) ||
      lower.indexOf('r2.dev') !== -1 ||
      lower.indexOf('r2.cloudflarestorage') !== -1 ||
      lower.indexOf('busycdn') !== -1 ||
      lower.indexOf('indexserver') !== -1) {
      return [_makeSource(resolvedUrl, q, 'Direct', { size: sz })];
    }
    if (/cuty\.io|filepress|fpgo\.|re\.php/i.test(lower)) {
      return [_makeSource(resolvedUrl, q, 'External Mirror', { size: sz, isDirectPlayable: false })];
    }
    return [];
  });
}

function getVideoSources(episodeUrl, opts) {
  return _get(episodeUrl, _baseOrigin(episodeUrl) + '/').then(function (html) {
    if (!html) throw new Error('AnimeDubHindi: failed to fetch episode links page');

    var epStr = _getQueryParam(episodeUrl, EPISODE_QUERY);
    var secStr = _getQueryParam(episodeUrl, SECTION_QUERY);
    var epNum = epStr != null ? parseInt(epStr, 10) : null;
    var secIdx = secStr != null ? parseInt(secStr, 10) : null;

    var allGroups = _extractBalancedDivBlocks(html, 'wp-block-group');
    var allCards = _extractBalancedDivBlocks(html, 'pro-ep-card');
    var targets = [];

    if (epNum != null && !isNaN(epNum)) {
      var combined = allGroups.concat(allCards);
      for (var i = 0; i < combined.length; i++) {
        if (_episodeNumber(htmlText(combined[i])) === epNum) {
          targets.push(combined[i]);
        }
      }
      if (targets.length === 0 && allCards.length > 0 && epNum >= 1 && epNum <= allCards.length) {
        targets.push(allCards[epNum - 1]);
      }
    } else if (secIdx != null && !isNaN(secIdx) && allGroups[secIdx]) {
      targets.push(allGroups[secIdx]);
    } else {
      var all = allGroups.concat(allCards);
      for (var j = 0; j < all.length; j++) {
        if (_hasDownloadLink(_extractAnchors(all[j], episodeUrl))) {
          targets.push(all[j]);
        }
      }
    }

    if (targets.length === 0) targets = [html];

    var rawItems = [];
    var seenHref = {};
    for (var t = 0; t < targets.length; t++) {
      var extracted = _extractDownloadItemsFromBlock(targets[t], episodeUrl);
      for (var ei = 0; ei < extracted.length; ei++) {
        if (!seenHref[extracted[ei].url]) {
          seenHref[extracted[ei].url] = 1;
          rawItems.push(extracted[ei]);
        }
      }
    }

    if (!rawItems.length) {
      throw new Error('AnimeDubHindi: no host download links found for episode');
    }

    return Promise.all(rawItems.map(function (it) {
      return _extractVideosForItem(it).catch(function () { return []; });
    })).then(function (lists) {
      var out = [];
      var seenUrl = {};
      for (var li = 0; li < lists.length; li++) {
        var list = lists[li] || [];
        for (var vi = 0; vi < list.length; vi++) {
          var v = list[vi];
          if (v && v.url && !seenUrl[v.url]) {
            seenUrl[v.url] = 1;
            out.push(v);
          }
        }
      }
      return out;
    });
  });
}
