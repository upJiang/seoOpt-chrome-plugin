import { describe, expect, it } from 'vitest';

import { getFindingCodeAdvice, groupRecommendationsByRootCause } from '../src/lib/audit/recommendations';
import { summarizeSeoPerformance } from '../src/lib/seo/performance';
import { finding } from './fixtures/snapshots';

describe('SEO project aggregation', () => {
  it('groups multiple findings by a shared root cause and URL scope', () => {
    const grouped = groupRecommendationsByRootCause([
      finding({ id: '1', status: 'warning', rootCauseId: 'template', affectedUrls: ['https://example.com/a'] }),
      finding({ id: '2', status: 'failure', rootCauseId: 'template', affectedUrls: ['https://example.com/b'] }),
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.findings).toHaveLength(2);
    expect(grouped[0]?.affectedUrls).toHaveLength(2);
  });

  it('provides executable code guidance or an explicit non-code boundary', () => {
    const codeAdvice = getFindingCodeAdvice(finding({ ruleId: 'links.valid-hrefs' }));
    expect(codeAdvice.label).toBe('通用 HTML 示例');
    expect(codeAdvice.code).toContain('<a href="/services/seo-audit">');
    expect(codeAdvice.note).toContain('实际框架');

    const nonCodeFinding = finding({ ruleId: 'content.visible-content' });
    delete nonCodeFinding.codeExample;
    const nonCodeAdvice = getFindingCodeAdvice(nonCodeFinding);
    expect(nonCodeAdvice.code).toBeNull();
    expect(nonCodeAdvice.note).toContain('不能仅靠一段前端代码');
  });

  it('separates brand traffic and finds query-page conflicts', () => {
    const base = { datasetId: 'd', projectId: 'p', platform: 'google' as const, date: '2026-08-01', ctr: 0.1, position: 5 };
    const summary = summarizeSeoPerformance([
      { ...base, id: '1', query: 'brand', page: '/a', impressions: 100, clicks: 10, branded: true },
      { ...base, id: '2', query: 'seo tool', page: '/a', impressions: 80, clicks: 8, branded: false },
      { ...base, id: '3', query: 'seo tool', page: '/b', impressions: 20, clicks: 2, branded: false },
    ]);
    expect(summary.branded.impressions).toBe(100);
    expect(summary.nonBranded.impressions).toBe(100);
    expect(summary.cannibalizationCandidates[0]).toMatchObject({ query: 'seo tool', impressions: 100 });
  });

  it('compares only complete, continuous, equal and mature search periods', () => {
    const base = { datasetId: 'd', projectId: 'p', platform: 'google' as const, query: 'seo tool', page: '/a', ctr: 0.1, position: 5 };
    const summary = summarizeSeoPerformance([
      { ...base, id: '1', date: '2026-08-01', impressions: 100, clicks: 10, branded: true },
      { ...base, id: '2', date: '2026-08-02', impressions: 100, clicks: 10, branded: false },
      { ...base, id: '3', date: '2026-08-03', impressions: 100, clicks: 8, branded: true },
      { ...base, id: '4', date: '2026-08-04', impressions: 100, clicks: 6, branded: false },
    ]);

    expect(summary.periodComparison?.period).toMatchObject({ days: 2, previousStart: '2026-08-01', currentEnd: '2026-08-04', maturityDays: 2 });
    expect(summary.periodComparison?.segments.branded.current.clicks).toBe(8);
    expect(summary.periodComparison?.segments.nonBranded.previous.clicks).toBe(10);
  });

  it('does not create trend conclusions from missing, discontinuous or immature dates', () => {
    const base = { datasetId: 'd', projectId: 'p', platform: 'google' as const, query: 'seo tool', page: '/a', ctr: 0.1, position: 5, impressions: 100, clicks: 10, branded: false };
    const discontinuous = ['2026-08-01', '2026-08-02', '2026-08-04', '2026-08-05'].map((date, index) => ({ ...base, id: String(index), date }));
    const immature = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'].map((date, index) => ({ ...base, id: `new-${index}`, date }));

    expect(summarizeSeoPerformance(discontinuous).periodComparison).toBeUndefined();
    expect(summarizeSeoPerformance(immature).periodComparison).toBeUndefined();
    expect(summarizeSeoPerformance(discontinuous).opportunities?.some((item) => item.id === 'decline:clicks')).toBe(false);
  });
});
