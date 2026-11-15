import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSupportedDownloadLanguages,
  buildSupportedDownloadQualities,
  buildSupportedDownloadQualitiesForServer,
  formatBytesCompact,
  formatTransferSpeed,
  groupDownloadServers,
  inferDownloadExtension,
  parseHumanSizeToBytes,
  selectMinimalDownloadEndpoint,
  unwrapProxyUrl,
} from './downloads';
import type { ProbedMediaMetadata, ZangetsuVideoSource } from '../types';

test('parseHumanSizeToBytes parses GB, MB, and KB accurately', () => {
  assert.equal(parseHumanSizeToBytes('1 GB'), 1024 * 1024 * 1024);
  assert.equal(parseHumanSizeToBytes('559 MB'), 559 * 1024 * 1024);
  assert.equal(parseHumanSizeToBytes('512 KB'), 512 * 1024);
  assert.equal(parseHumanSizeToBytes('Unknown'), 0);
  assert.equal(parseHumanSizeToBytes(undefined), 0);
});

test('formatBytesCompact & formatTransferSpeed format MB and MB/s cleanly', () => {
  assert.equal(formatBytesCompact(559 * 1024 * 1024), '559.0 MB');
  assert.equal(formatBytesCompact(1.5 * 1024 * 1024 * 1024), '1.50 GB');
  assert.equal(formatTransferSpeed(2.5 * 1024 * 1024), '2.50 MB/s');
  assert.equal(formatTransferSpeed(640 * 1024), '640 KB/s');
});

test('buildSupportedDownloadLanguages never fabricates dummy languages', () => {
  const source: ZangetsuVideoSource = {
    url: 'https://cdn.example.com/movie.mp4',
    quality: '1080p',
    container: 'mp4',
    label: 'Turbo 1080p',
    audioLang: 'Hindi',
  };

  const single = buildSupportedDownloadLanguages({
    source,
    probedMeta: null,
    hlsAudioTracks: [],
    hasSubDubToggle: false,
    audioCategory: 'sub',
  });
  assert.equal(single.length, 1);
  assert.equal(single[0].label, 'Hindi');

  const probedMeta: ProbedMediaMetadata = {
    duration: 3600,
    sizeBytes: 1200000000,
    formatName: 'matroska',
    videoCodec: 'h264',
    width: 1920,
    height: 1080,
    needsRemux: true,
    subtitleTracks: [],
    audioTracks: [
      {
        index: 0,
        streamIndex: 1,
        codec: 'AAC',
        language: 'Hindi',
        title: 'Hindi',
        channels: 2,
        channelLayout: 'stereo',
        bitrate: '128 kbps',
        isDefault: true,
      },
      {
        index: 1,
        streamIndex: 2,
        codec: 'EAC3',
        language: 'English',
        title: 'English',
        channels: 6,
        channelLayout: '5.1',
        bitrate: '384 kbps',
        isDefault: false,
      },
    ],
  };

  const probed = buildSupportedDownloadLanguages({
    source,
    probedMeta,
    hlsAudioTracks: [],
    hasSubDubToggle: false,
    audioCategory: 'sub',
  });
  assert.deepEqual(
    probed.map((p) => p.label),
    ['Hindi', 'English']
  );
});

test('buildSupportedDownloadQualities lists only real HLS levels or real source quality + optional Data Saver', () => {
  const hlsSource: ZangetsuVideoSource = {
    url: 'https://cdn.example.com/master.m3u8',
    quality: 'auto',
    container: 'hls',
    label: 'Spiral HLS',
  };

  const hlsQualities = buildSupportedDownloadQualities({
    source: hlsSource,
    probedMeta: null,
    hlsLevels: [
      { index: 0, height: 360, bitrate: 450_000, variantUrl: '/api/proxy?url=https%3A%2F%2Fcdn.example.com%2F360.m3u8' },
      { index: 1, height: 720, bitrate: 1_500_000, variantUrl: '/api/proxy?url=https%3A%2F%2Fcdn.example.com%2F720.m3u8' },
      { index: 2, height: 1080, bitrate: 3_000_000, variantUrl: '/api/proxy?url=https%3A%2F%2Fcdn.example.com%2F1080.m3u8' },
    ],
    hlsAudioTracksCount: 0,
  });

  assert.deepEqual(
    hlsQualities.map((q) => q.label),
    ['1080p', '720p', '360p']
  );
  assert.equal(hlsQualities[2].variantUrl, 'https://cdn.example.com/360.m3u8');

  const mp4Source: ZangetsuVideoSource = {
    url: 'https://cdn.example.com/film.mp4',
    quality: '1080p',
    container: 'mp4',
    label: 'Turbo 1080p',
    size: '1.11 GB',
  };
  const mp4Qualities = buildSupportedDownloadQualities({
    source: mp4Source,
    probedMeta: null,
    hlsLevels: [],
  });
  assert.deepEqual(
    mp4Qualities.map((q) => q.label),
    ['1080p', '480p (Data Saver)']
  );
});

test('selectMinimalDownloadEndpoint uses fast /api/proxy for direct MP4/MKV on default track and /api/stream/remux for HLS, secondary audio, or Data Saver', () => {
  const mkvSource: ZangetsuVideoSource = {
    url: 'https://cdn.example.com/film.mkv',
    quality: '1080p',
    container: 'mp4',
    label: 'Pixeldrain',
  };
  const directMkvEndpoint = selectMinimalDownloadEndpoint({
    source: mkvSource,
    quality: {
      id: 'source-original',
      label: '1080p',
      containerLabel: 'MKV · Fast',
      sizeLabel: '1.11 GB',
      estimatedBytes: 1_191_853_424,
      hlsLevelIndex: -1,
    },
    audioIndex: 0,
    probedMeta: null,
    filename: 'film.mkv',
  });
  assert.ok(directMkvEndpoint.startsWith('/api/proxy?'));
  assert.equal(inferDownloadExtension(directMkvEndpoint, mkvSource.url), 'mkv');

  const secondaryTrackEndpoint = selectMinimalDownloadEndpoint({
    source: mkvSource,
    quality: {
      id: 'source-original',
      label: '1080p',
      containerLabel: 'MKV · Fast',
      sizeLabel: '1.11 GB',
      estimatedBytes: 1_191_853_424,
      hlsLevelIndex: -1,
    },
    audioIndex: 1,
    probedMeta: null,
    filename: 'film.mp4',
  });
  assert.ok(secondaryTrackEndpoint.startsWith('/api/stream/remux?'));
  assert.equal(inferDownloadExtension(secondaryTrackEndpoint, mkvSource.url), 'mp4');

  const compactEndpoint = selectMinimalDownloadEndpoint({
    source: mkvSource,
    quality: {
      id: 'source-compact-480',
      label: '480p (Data Saver)',
      containerLabel: 'Compact MP4',
      sizeLabel: '~400 MB',
      estimatedBytes: 400_000_000,
      hlsLevelIndex: -1,
      compactMaxHeight: 480,
      isDataSaver: true,
    },
    audioIndex: 0,
    probedMeta: null,
    filename: 'film_480p.mp4',
  });
  assert.ok(compactEndpoint.startsWith('/api/stream/remux?'));
  assert.ok(compactEndpoint.includes('compact=1&maxHeight=480'));
  assert.equal(
    unwrapProxyUrl('/api/proxy?url=https%3A%2F%2Fcdn.example.com%2F720.m3u8&headers=%7B%7D'),
    'https://cdn.example.com/720.m3u8'
  );
});

test('groupDownloadServers deduplicates server pills, places Pixeldrain first, and lists unique real qualities', () => {
  const multiSources: ZangetsuVideoSource[] = [
    { url: 'https://cdn/fsl-720.mp4', quality: '720p', container: 'mp4', label: 'FSL 720p', server: 'FSL Server', size: '475 MB' },
    { url: 'https://cdn/fsl-720-dup.mp4', quality: '720p', container: 'mp4', label: 'FSL 720p', server: 'FSL Server', size: '475 MB' },
    { url: 'https://cdn/pd-720.mp4', quality: '720p', container: 'mp4', label: 'PD 720p', server: 'Pixeldrain', size: '475 MB' },
    { url: 'https://cdn/fsl-1080.mp4', quality: '1080p', container: 'mp4', label: 'FSL 1080p', server: 'FSL Server', size: '1.11 GB' },
    { url: 'https://cdn/fsl-480.mp4', quality: '480p', container: 'mp4', label: 'FSL 480p', server: 'FSL Server', size: '210 MB' },
  ];

  const groups = groupDownloadServers(multiSources);
  assert.deepEqual(
    groups.map((g) => g.serverName),
    ['Pixeldrain', 'FSL Server']
  );

  const fslQualities = buildSupportedDownloadQualitiesForServer({
    serverGroup: groups[1],
    primarySource: groups[1].items[0].source,
    probedMeta: null,
    hlsLevels: [],
  });
  assert.deepEqual(
    fslQualities.map((q) => q.label),
    ['1080p', '720p', '480p']
  );
  assert.equal(fslQualities[0].targetSource?.url, 'https://cdn/fsl-1080.mp4');
});

