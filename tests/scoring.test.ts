import { describe, expect, it } from 'vitest';

import { calculateScores } from '../src/lib/audit/scoring';
import { AUDIT_RULES } from '../src/lib/audit/rules';
import { CATEGORY_CONFIG, type AuditCategory } from '../src/lib/audit/types';
import { finding } from './fixtures/snapshots';

describe('calculateScores', () => {
  it('normalizes only applicable and measurable rules', () => {
    const result = calculateScores([
      finding({ id: 'pass', points: 7, status: 'pass', scoreRatio: 1 }),
      finding({ id: 'failure', points: 3, status: 'failure', scoreRatio: 0 }),
      finding({ id: 'unmeasurable', points: 90, status: 'not_measurable', scoreRatio: null }),
      finding({ id: 'not-applicable', points: 20, status: 'not_applicable', scoreRatio: null }),
    ]);

    expect(result.overallScore).toBe(70);
    expect(result.coverage).toBe(67);
    expect(result.measuredChecks).toBe(2);
    expect(result.measurableChecks).toBe(3);
  });

  it('awards half points for warnings', () => {
    const result = calculateScores([
      finding({ id: 'warning', status: 'warning', scoreRatio: 0.5 }),
    ]);
    expect(result.overallScore).toBe(50);
    expect(result.scoreLabel).toBe('待优化');
  });

  it('caps P0 indexing blockers at 39', () => {
    const result = calculateScores([
      finding({ id: 'pass', points: 95 }),
      finding({ id: 'p0', category: 'discoverability', points: 5, status: 'failure', scoreRatio: 0, priority: 'P0', scoreCap: 39 }),
    ]);
    expect(result.overallScore).toBe(39);
  });

  it('caps P1 indexing risks at 69', () => {
    const result = calculateScores([
      finding({ id: 'pass', points: 95 }),
      finding({ id: 'p1', category: 'discoverability', points: 5, status: 'failure', scoreRatio: 0, priority: 'P1', scoreCap: 69 }),
    ]);
    expect(result.overallScore).toBe(69);
  });

  it('keeps configured rule points aligned with the six category weights', () => {
    for (const category of Object.keys(CATEGORY_CONFIG) as AuditCategory[]) {
      const points = AUDIT_RULES
        .filter((rule) => rule.category === category)
        .reduce((total, rule) => total + rule.points, 0);
      expect(points, category).toBe(CATEGORY_CONFIG[category].points);
    }
  });
});
