import { describe, expect, it } from 'vitest';

import { buildScoreDetails } from '../src/lib/audit/score-details';
import { buildAuditReport } from '../src/lib/audit/rules';
import { finding, healthySnapshot } from './fixtures/snapshots';

describe('buildScoreDetails', () => {
  it('separates awarded and deducted applicable rule points', () => {
    const report = buildAuditReport(healthySnapshot(), 3);
    report.findings = [
      finding({ id: 'pass', title: '通过项', points: 7, status: 'pass', scoreRatio: 1 }),
      finding({ id: 'warning', title: '警告项', points: 6, status: 'warning', scoreRatio: 0.5 }),
      finding({ id: 'failure', title: '失败项', points: 2, status: 'failure', scoreRatio: 0 }),
      finding({ id: 'unmeasurable', title: '不可测', points: 50, status: 'not_measurable', scoreRatio: null }),
    ];

    const details = buildScoreDetails(report);

    expect(details.earnedPoints).toBe(10);
    expect(details.possiblePoints).toBe(15);
    expect(details.deductedPoints).toBe(5);
    expect(details.normalizedScore).toBe(67);
    expect(details.passed.map((item) => item.finding.id)).toEqual(['pass', 'warning']);
    expect(details.deducted.map((item) => item.finding.id)).toEqual(['warning', 'failure']);
  });

  it('reports score caps independently from raw point deductions', () => {
    const report = buildAuditReport(healthySnapshot(), 3);
    report.findings = [
      finding({ id: 'pass', points: 95, status: 'pass', scoreRatio: 1 }),
      finding({ id: 'blocker', title: '索引阻断', points: 5, status: 'failure', scoreRatio: 0, priority: 'P0', scoreCap: 39 }),
    ];

    const details = buildScoreDetails(report);

    expect(details.normalizedScore).toBe(95);
    expect(details.caps).toHaveLength(1);
    expect(details.caps[0]).toMatchObject({ cap: 39 });
  });
});
