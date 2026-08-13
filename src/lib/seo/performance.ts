import type { EvidenceConfidence, SeoOpportunity, SeoPerformanceRow, SeoPerformanceSummary } from '../projects/types';

interface Totals { impressions: number; clicks: number; ctr: number }

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function normalizePage(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.href;
  } catch {
    return value.trim().replace(/#.*$/, '').replace(/\/+$/, '') || value.trim();
  }
}

function positionBucket(position: number | null): string {
  if (position === null || !Number.isFinite(position)) return '未知位置';
  if (position <= 3) return '1-3';
  if (position <= 10) return '4-10';
  if (position <= 20) return '11-20';
  return '21+';
}

function confidenceFor(impressions: number, clicks: number): EvidenceConfidence {
  if (impressions >= 5_000 && clicks >= 100) return 'high';
  if (impressions >= 1_000 && clicks >= 30) return 'medium';
  return 'low';
}

function aggregate(rows: SeoPerformanceRow[]): Totals {
  const impressions = rows.reduce((total, row) => total + Math.max(0, row.impressions), 0);
  const clicks = rows.reduce((total, row) => total + Math.max(0, row.clicks), 0);
  return { impressions, clicks, ctr: ratio(clicks, impressions) };
}

function periodComparison(rows: SeoPerformanceRow[]): SeoPerformanceSummary['periodComparison'] {
  const dated = rows.filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date)).sort((a, b) => a.date.localeCompare(b.date));
  const dates = [...new Set(dated.map((row) => row.date))];
  if (dates.length < 2) return undefined;
  const days = Math.floor(dates.length / 2);
  if (!days) return undefined;
  const previousDates = new Set(dates.slice(-days * 2, -days));
  const currentDates = new Set(dates.slice(-days));
  const previous = aggregate(dated.filter((row) => previousDates.has(row.date)));
  const current = aggregate(dated.filter((row) => currentDates.has(row.date)));
  const change = {
    impressions: previous.impressions > 0 ? current.impressions / previous.impressions - 1 : null,
    clicks: previous.clicks > 0 ? current.clicks / previous.clicks - 1 : null,
    ctr: previous.ctr > 0 ? current.ctr / previous.ctr - 1 : null,
  };
  return { current, previous, change, confidence: confidenceFor(current.impressions + previous.impressions, current.clicks + previous.clicks) };
}

function makeOpportunities(rows: SeoPerformanceRow[], pageMatrix: NonNullable<SeoPerformanceSummary['pageMatrix']>, cannibalizationCandidates: SeoPerformanceSummary['cannibalizationCandidates']): SeoOpportunity[] {
  const opportunities: SeoOpportunity[] = [];
  const bucketRows = new Map<string, SeoPerformanceRow[]>();
  for (const row of rows) {
    const bucket = positionBucket(row.position);
    bucketRows.set(bucket, [...(bucketRows.get(bucket) || []), row]);
  }
  const baselines = new Map([...bucketRows.entries()].map(([bucket, values]) => [bucket, aggregate(values).ctr]));
  const queryAggregates = new Map<string, SeoPerformanceRow[]>();
  for (const row of rows) if (row.query.trim() && row.page.trim()) queryAggregates.set(`${row.query}\u0000${normalizePage(row.page)}`, [...(queryAggregates.get(`${row.query}\u0000${normalizePage(row.page)}`) || []), row]);

  const snippetCandidates = [...queryAggregates.entries()]
    .map(([key, values]) => ({ key, values, total: aggregate(values), position: values.find((row) => row.position !== null)?.position ?? null }))
    .filter((candidate) => candidate.total.impressions >= 50 && candidate.position !== null && candidate.position <= 20)
    .map((candidate) => ({ ...candidate, baseline: baselines.get(positionBucket(candidate.position)) || 0 }))
    .filter((candidate) => candidate.baseline > 0 && candidate.total.ctr < candidate.baseline * 0.7)
    .sort((a, b) => b.total.impressions - a.total.impressions);
  for (const candidate of snippetCandidates.slice(0, 10)) {
    const [query = '', page = ''] = candidate.key.split('\u0000');
    opportunities.push({
      id: `snippet:${query}:${page}`,
      kind: 'snippet',
      title: '高展现但点击率低于本站同位置基线',
      priority: candidate.position! <= 10 ? 'P1' : 'P2',
      confidence: confidenceFor(candidate.total.impressions, candidate.total.clicks),
      evidence: `查询“${query}”在 ${positionBucket(candidate.position)} 位，${candidate.total.impressions.toLocaleString()} 次展现，CTR ${(candidate.total.ctr * 100).toFixed(2)}%，本站同位置基线 ${(candidate.baseline * 100).toFixed(2)}%。`,
      action: '先重写 Title 和 Description 的表达与承诺，确保首屏和页面任务兑现摘要，不靠堆关键词提高 CTR。',
      affectedUrls: [page],
    });
  }

  const nearWins = [...queryAggregates.entries()]
    .map(([key, values]) => ({ key, values, total: aggregate(values), position: values.find((row) => row.position !== null)?.position ?? null }))
    .filter((candidate) => candidate.position !== null && candidate.position >= 4 && candidate.position <= 20 && candidate.total.impressions >= 50)
    .sort((a, b) => b.total.impressions - a.total.impressions);
  for (const candidate of nearWins.slice(0, 10)) {
    const [query = '', page = ''] = candidate.key.split('\u0000');
    opportunities.push({
      id: `near-win:${query}:${page}`,
      kind: 'near_win',
      title: '排名在可增长区间的页面',
      priority: candidate.position! <= 10 ? 'P1' : 'P2',
      confidence: confidenceFor(candidate.total.impressions, candidate.total.clicks),
      evidence: `查询“${query}”平均约 ${candidate.position!.toFixed(1)} 位，有 ${candidate.total.impressions.toLocaleString()} 次展现。`,
      action: '围绕同一搜索任务补充证据和内链，优先修正页面结构与首屏承诺，再用等长周期观察位置和点击变化。',
      affectedUrls: [page],
    });
  }

  for (const candidate of cannibalizationCandidates.slice(0, 10)) {
    opportunities.push({
      id: `cannibalization:${candidate.query}`,
      kind: 'cannibalization',
      title: '一个查询对应多个页面',
      priority: candidate.impressions >= 1_000 ? 'P1' : 'P2',
      confidence: candidate.pages.length > 2 ? 'medium' : 'low',
      evidence: `查询“${candidate.query}”在 ${candidate.pages.length} 个页面产生 ${candidate.impressions.toLocaleString()} 次展现。`,
      action: '按页面任务选择主页面；合并重复页面、调整 Canonical 或用内链明确主次，不要只把相同关键词复制到所有页面。',
      affectedUrls: candidate.pages.slice(0, 20).map(normalizePage),
    });
  }

  const dates = periodComparison(rows);
  if (dates && dates.change.clicks !== null && dates.change.clicks < -0.2) {
    const declining = [...pageMatrix].filter((page) => page.clicks > 0).slice(0, 10).map((page) => page.page);
    opportunities.push({
      id: 'decline:clicks',
      kind: 'content',
      title: '当前周期自然点击下降',
      priority: 'P1',
      confidence: dates.confidence,
      evidence: `与前一等长周期相比，点击变化 ${(dates.change.clicks * 100).toFixed(1)}%。需要结合改版、排名和查询结构定位原因。`,
      action: '按 URL、查询、品牌/非品牌和页面模板拆分下降，先排除抓取、索引和追踪变化，再选择页面修复。',
      affectedUrls: declining,
    });
  }
  return opportunities;
}

export function summarizeSeoPerformance(rows: SeoPerformanceRow[]): SeoPerformanceSummary {
  const impressions = rows.reduce((total, row) => total + row.impressions, 0);
  const clicks = rows.reduce((total, row) => total + row.clicks, 0);
  const positioned = rows.filter((row) => row.position !== null && row.impressions > 0);
  const weightedPosition = positioned.reduce((total, row) => total + row.position! * row.impressions, 0);
  const positionedImpressions = positioned.reduce((total, row) => total + row.impressions, 0);
  const brandedRows = rows.filter((row) => row.branded);
  const nonBrandedRows = rows.filter((row) => !row.branded);
  const queryPages = new Map<string, { pages: Set<string>; impressions: number }>();
  for (const row of rows) {
    if (!row.query || !row.page) continue;
    const entry = queryPages.get(row.query) ?? { pages: new Set<string>(), impressions: 0 };
    entry.pages.add(normalizePage(row.page));
    entry.impressions += row.impressions;
    queryPages.set(row.query, entry);
  }
  const cannibalizationCandidates = [...queryPages.entries()]
    .filter(([, value]) => value.pages.size > 1)
    .map(([query, value]) => ({ query, pages: [...value.pages], impressions: value.impressions }))
    .sort((left, right) => right.impressions - left.impressions)
    .slice(0, 20);
  const pageGroups = new Map<string, SeoPerformanceRow[]>();
  for (const row of rows) if (row.page) pageGroups.set(normalizePage(row.page), [...(pageGroups.get(normalizePage(row.page)) || []), row]);
  const pageMatrix = [...pageGroups.entries()].map(([page, values]) => {
    const totals = aggregate(values);
    const positionedValues = values.filter((row) => row.position !== null && row.impressions > 0);
    const positionImpressions = positionedValues.reduce((sum, row) => sum + row.impressions, 0);
    return {
      page,
      impressions: totals.impressions,
      clicks: totals.clicks,
      ctr: totals.ctr,
      averagePosition: positionImpressions ? positionedValues.reduce((sum, row) => sum + row.position! * row.impressions, 0) / positionImpressions : null,
      queryCount: new Set(values.map((row) => row.query).filter(Boolean)).size,
      branded: values.filter((row) => row.branded).reduce((sum, row) => sum + row.impressions, 0) >= values.filter((row) => !row.branded).reduce((sum, row) => sum + row.impressions, 0),
    };
  }).sort((a, b) => b.impressions - a.impressions);
  const baselineGroups = new Map<string, SeoPerformanceRow[]>();
  for (const row of rows) {
    const bucket = positionBucket(row.position);
    baselineGroups.set(bucket, [...(baselineGroups.get(bucket) || []), row]);
  }
  const ctrBaselines = [...baselineGroups.entries()].map(([bucket, values]) => ({ bucket, ...aggregate(values) })).sort((a, b) => a.bucket.localeCompare(b.bucket));
  const summary: SeoPerformanceSummary = {
    rows: rows.length,
    impressions,
    clicks,
    ctr: ratio(clicks, impressions),
    averagePosition: positionedImpressions > 0 ? weightedPosition / positionedImpressions : null,
    branded: { impressions: brandedRows.reduce((total, row) => total + row.impressions, 0), clicks: brandedRows.reduce((total, row) => total + row.clicks, 0) },
    nonBranded: { impressions: nonBrandedRows.reduce((total, row) => total + row.impressions, 0), clicks: nonBrandedRows.reduce((total, row) => total + row.clicks, 0) },
    cannibalizationCandidates,
    opportunities: [],
    pageMatrix,
    queryPageConflictCount: cannibalizationCandidates.length,
    ctrBaselines,
    ...(periodComparison(rows) ? { periodComparison: periodComparison(rows)! } : {}),
  };
  summary.opportunities = makeOpportunities(rows, pageMatrix, cannibalizationCandidates);
  return summary;
}
