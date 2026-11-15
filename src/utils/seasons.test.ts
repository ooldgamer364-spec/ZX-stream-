import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inferSeasonFromTitle,
  extractEpisodeSeasonNumber,
  formatCleanEpisodeTitle,
  groupEpisodesBySeason,
} from './seasons.ts';

test('inferSeasonFromTitle extracts season number from titles like MobLand Season 2', () => {
  assert.equal(inferSeasonFromTitle('MobLand Season 2'), 2);
  assert.equal(inferSeasonFromTitle('Black Clover: Season 3'), 3);
  assert.equal(inferSeasonFromTitle('Stranger Things'), 1);
});

test('groupEpisodesBySeason groups multi-season S1E1/S2E1/S3E1 feeds into sorted Season groups', () => {
  const episodes = [
    { id: 'S2E1', number: 1, title: 'S2 E1 - Episode 1' },
    { id: 'S1E1', number: 1, title: 'S1 E1 - Episode 1' },
    { id: 'S1E2', number: 2, title: 'S1 E2 - Episode 2' },
    { id: 'S3E1', number: 1, title: 'S3 E1 - Episode 1' },
    { id: 'S2E2', number: 2, title: 'S2 E2 - Episode 2' },
  ];
  const groups = groupEpisodesBySeason(episodes, 'Stranger Things');
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups.map((g) => ({ season: g.seasonNumber, label: g.label, count: g.episodes.length })),
    [
      { season: 1, label: 'Season 1', count: 2 },
      { season: 2, label: 'Season 2', count: 2 },
      { season: 3, label: 'Season 3', count: 1 },
    ]
  );
});

test('groupEpisodesBySeason respects Season N in mediaTitle for single-season pages without S-prefix', () => {
  const episodes = [
    { id: 'E1', number: 1, title: 'Episode 1' },
    { id: 'E2', number: 2, title: 'Episode 2' },
  ];
  const groups = groupEpisodesBySeason(episodes, 'Panchayat Season 4');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].seasonNumber, 4);
  assert.equal(groups[0].label, 'Season 4');
});

test('extractEpisodeSeasonNumber and formatCleanEpisodeTitle parse HiAnime and 4KHDHub formats', () => {
  assert.equal(extractEpisodeSeasonNumber({ id: 'sub:1', title: "I'm used to it" }, 1), 1);
  assert.equal(extractEpisodeSeasonNumber({ id: 'S4E5', title: 'S4 E5 - The Bite' }, 1), 4);
  assert.equal(formatCleanEpisodeTitle({ number: 5, title: 'S4 E5 - The Bite' }), 'The Bite');
  assert.equal(formatCleanEpisodeTitle({ number: 1, title: "I'm used to it" }), "I'm used to it");
});
