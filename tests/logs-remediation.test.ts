import { describe, expect, it } from 'vitest';

import { parseServerLog } from '../src/lib/logs/parser';
import { diffBaselines, sortRemediationTasks } from '../src/lib/remediation/tasks';
import type { AuditBaseline, RemediationTask } from '../src/lib/projects/types';

function task(overrides: Partial<RemediationTask>): RemediationTask {
  return {
    id: crypto.randomUUID(), projectId: 'p', rootCauseId: 'root', title: '任务', status: 'todo', priority: 'P2', confidence: 'medium', owner: 'SEO', effort: '中', evidence: '证据', why: '影响', action: '修改', affectedUrls: [], verification: '复测', observationPeriod: '两周', rollback: '恢复', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', ...overrides,
  };
}

function baseline(overrides: Partial<AuditBaseline>): AuditBaseline {
  return { id: crypto.randomUUID(), projectId: 'p', createdAt: '2026-08-01T00:00:00Z', overallScore: 60, findingStates: {}, pageSignals: { title: '旧标题', status: 200 }, siteIssueCount: 0, ...overrides };
}

describe('server log privacy and remediation loop', () => {
  it('keeps only aggregate evidence and drops IP, referer and raw user agent', () => {
    const input = '203.0.113.10 - - [05/Aug/2026:10:00:00 +0800] "GET /catalog?utm_source=test HTTP/1.1" 404 123 "https://secret.example/private" "Googlebot/2.1 (+http://www.google.com/bot.html)" request_time=1.200';
    const summary = parseServerLog({ projectId: 'p', content: input, format: 'nginx', sitemapUrls: ['/catalog', '/missing'] });
    const serialized = JSON.stringify(summary);
    expect(summary).toMatchObject({ requestCount: 1, privacy: 'aggregated_only', statusCounts: { '404': 1 } });
    expect(summary.botFamilies[0]).toMatchObject({ family: 'Google', verified: false });
    expect(summary.wastedUrlCandidates[0]?.url).toBe('/catalog?utm_source=test');
    expect(serialized).not.toContain('203.0.113.10');
    expect(serialized).not.toContain('secret.example');
    expect(serialized).not.toContain('Googlebot/2.1');
  });

  it('sorts by priority, confidence, affected URLs and then effort', () => {
    const sorted = sortRemediationTasks([
      task({ id: 'p2-low', priority: 'P2', confidence: 'low', affectedUrls: Array(10).fill('/a') }),
      task({ id: 'p1-low', priority: 'P1', confidence: 'low', affectedUrls: ['/a'] }),
      task({ id: 'p1-high-one', priority: 'P1', confidence: 'high', affectedUrls: ['/a'] }),
      task({ id: 'p1-high-many', priority: 'P1', confidence: 'high', affectedUrls: ['/a', '/b'] }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(['p1-high-many', 'p1-high-one', 'p1-low', 'p2-low']);
  });

  it('separates technical fixes from new risks and changed page evidence', () => {
    const before = baseline({ id: 'before', overallScore: 55, findingStates: { title: { status: 'failure', priority: 'P1', evidence: '缺失' }, canonical: { status: 'pass', priority: 'P2', evidence: '正常' } } });
    const after = baseline({ id: 'after', overallScore: 75, findingStates: { title: { status: 'pass', priority: 'P1', evidence: '存在' }, canonical: { status: 'warning', priority: 'P2', evidence: '变化' }, h1: { status: 'warning', priority: 'P2', evidence: '重复' } }, pageSignals: { title: '新标题', status: 200 } });
    expect(diffBaselines(before, after)).toMatchObject({
      score: { before: 55, after: 75, delta: 20 },
      fixedRules: ['title'],
      newRules: ['h1'],
      changedRules: ['canonical'],
      pageSignals: [{ key: 'title', before: '旧标题', after: '新标题' }],
    });
  });
});
