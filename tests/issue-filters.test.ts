import { describe, expect, it } from 'vitest';

import {
  countIssueCategories,
  filterIssueFindings,
} from '../src/lib/audit/issue-filters';
import { finding } from './fixtures/snapshots';

describe('issue filters', () => {
  const findings = [
    finding({ id: 'metadata-failure', category: 'metadata', status: 'failure', priority: 'P1' }),
    finding({ id: 'metadata-pass', category: 'metadata', status: 'pass', priority: 'P3' }),
    finding({ id: 'performance-warning', category: 'performance', status: 'warning', priority: 'P2' }),
    finding({ id: 'performance-pass', category: 'performance', status: 'pass', priority: 'P3' }),
    finding({ id: 'links-info', category: 'links', status: 'informational', priority: 'P3' }),
  ];

  it('defaults to failure and warning findings only', () => {
    const result = filterIssueFindings(findings, {
      priority: 'all',
      category: 'all',
      status: 'actionable',
    });

    expect(result.map((item) => item.id)).toEqual(['metadata-failure', 'performance-warning']);
  });

  it('counts categories from the active priority and status filters', () => {
    expect(countIssueCategories(findings, 'all', 'actionable')).toEqual({
      all: 2,
      discoverability: 0,
      metadata: 1,
      content: 0,
      links: 0,
      media: 0,
      performance: 1,
    });
    expect(countIssueCategories(findings, 'P1', 'actionable')).toMatchObject({
      all: 1,
      metadata: 1,
      performance: 0,
    });
    expect(countIssueCategories(findings, 'all', 'all')).toMatchObject({
      all: 5,
      metadata: 2,
      performance: 2,
      links: 1,
    });
  });
});
