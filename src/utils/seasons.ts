export interface SeasonGroup<T> {
  seasonNumber: number;
  label: string;
  episodes: T[];
}

export function inferSeasonFromTitle(title?: string | null): number {
  const str = String(title || '');
  const match = str.match(/\b(?:season|s)\s*[-:.]?\s*(\d{1,2})\b/i);
  if (match) {
    const n = parseInt(match[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1;
}

export function extractEpisodeSeasonNumber(
  ep: { id?: string; title?: string; season?: number },
  fallbackSeason = 1
): number {
  if (typeof ep.season === 'number' && Number.isFinite(ep.season) && ep.season > 0) {
    return ep.season;
  }

  const idStr = String(ep.id || '');
  const idMatch =
    idStr.match(/^S(\d{1,2})E\d+/i) ||
    idStr.match(/\bS(\d{1,2})\b/i) ||
    idStr.match(/season[-_\s]?(\d{1,2})/i);
  if (idMatch) {
    const n = parseInt(idMatch[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const titleStr = String(ep.title || '');
  const titleMatch =
    titleStr.match(/^S(\d{1,2})\s*[-:]?\s*E\d+/i) ||
    titleStr.match(/\bSeason\s*(\d{1,2})\b/i);
  if (titleMatch) {
    const n = parseInt(titleMatch[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return fallbackSeason > 0 ? fallbackSeason : 1;
}

export function formatCleanEpisodeTitle(ep: { number: number; title?: string }): string {
  const raw = String(ep.title || '').trim();
  const stripped = raw.replace(/^S\d{1,2}\s*[-:]?\s*E\d+\s*[-–:]?\s*/i, '').trim();
  if (!stripped) return `Episode ${ep.number}`;
  return stripped;
}

export function groupEpisodesBySeason<
  T extends { id: string; number: number; title: string; season?: number }
>(episodes: T[], mediaTitle?: string | null): SeasonGroup<T>[] {
  if (!episodes || episodes.length === 0) return [];
  const fallbackSeason = inferSeasonFromTitle(mediaTitle);
  const map = new Map<number, T[]>();

  for (const ep of episodes) {
    const seasonNum = extractEpisodeSeasonNumber(ep, fallbackSeason);
    const list = map.get(seasonNum) || [];
    list.push(ep);
    map.set(seasonNum, list);
  }

  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([seasonNumber, eps]) => ({
      seasonNumber,
      label: `Season ${seasonNumber}`,
      episodes: eps,
    }));
}
