import { describe, expect, it } from 'vitest';

import { buildRecommendationSections, getExpectedOutcome } from '../src/lib/audit/recommendations';
import { finding } from './fixtures/snapshots';

describe('recommendation sections', () => {
  it('routes actionable findings into a single execution lane', () => {
    const sections = buildRecommendationSections([
      finding({ id: 'p1', status: 'failure', priority: 'P1', points: 4 }),
      finding({ id: 'quick', status: 'warning', priority: 'P2', effort: '低', points: 3 }),
      finding({ id: 'planned', status: 'warning', priority: 'P2', effort: '中', points: 5 }),
      finding({ id: 'watch', status: 'warning', priority: 'P3' }),
      finding({ id: 'pass', status: 'pass', priority: 'P1' }),
    ]);

    expect(sections.map((section) => section.findings.map((item) => item.id))).toEqual([
      ['p1'],
      ['quick'],
      ['planned'],
      ['watch'],
    ]);
  });

  it('keeps failures and higher-point findings first within a lane', () => {
    const [urgent] = buildRecommendationSections([
      finding({ id: 'warning', status: 'warning', priority: 'P1', points: 8 }),
      finding({ id: 'small', status: 'failure', priority: 'P1', points: 2 }),
      finding({ id: 'large', status: 'failure', priority: 'P1', points: 6 }),
    ]);

    expect(urgent?.findings.map((item) => item.id)).toEqual(['large', 'small', 'warning']);
  });

  it('returns empty lanes when the page has no actionable findings', () => {
    const sections = buildRecommendationSections([finding({ status: 'pass' })]);
    expect(sections.every((section) => section.findings.length === 0)).toBe(true);
  });

  it('explains category-specific expected outcomes without promising rankings', () => {
    const outcome = getExpectedOutcome(finding({ category: 'discoverability' }));
    expect(outcome).toContain('抓取与索引信号');
    expect(outcome).toContain('仍需');
  });
});
