import { describe, expect, it } from 'vitest';

import { buildAuditReport, inferAuditContext, AUDIT_RULES } from '../src/lib/audit/rules';
import { DEFAULT_CONTEXT } from '../src/lib/audit/types';
import { healthySnapshot } from './fixtures/snapshots';

function runRule(id: string, snapshot = healthySnapshot(), context = DEFAULT_CONTEXT) {
  const rule = AUDIT_RULES.find((candidate) => candidate.id === id);
  if (!rule) throw new Error(`Missing rule ${id}`);
  return rule.run(snapshot, context);
}

describe('core audit rules', () => {
  it('detects missing title and description', () => {
    const snapshot = healthySnapshot({ titleTags: [], descriptions: [] });
    expect(runRule('metadata.title', snapshot).status).toBe('failure');
    expect(runRule('metadata.description', snapshot).status).toBe('warning');
  });

  it('treats noindex on an expected index page as P0', () => {
    const result = runRule('discoverability.index-directives', healthySnapshot({ robotsMeta: ['noindex,follow'] }), {
      ...DEFAULT_CONTEXT,
      expectedIndexState: 'index',
    });
    expect(result.status).toBe('failure');
    expect(result.priority).toBe('P0');
    expect(result.scoreCap).toBe(39);
  });

  it('asks for confirmation instead of creating P0 when index intent is unknown', () => {
    const result = runRule('discoverability.index-directives', healthySnapshot({ robotsMeta: ['noindex,follow'] }));
    expect(result.status).toBe('informational');
    expect(result.scoreCap).toBeUndefined();
  });

  it('detects conflicting canonical declarations', () => {
    const result = runRule('discoverability.canonical', healthySnapshot({
      canonicals: ['https://example.com/a', 'https://example.com/b'],
    }));
    expect(result.status).toBe('failure');
  });

  it('detects invalid JSON-LD, image and link evidence', () => {
    const base = healthySnapshot();
    const snapshot = healthySnapshot({
      jsonLd: [{ ...base.jsonLd[0]!, valid: false, error: 'Unexpected token', types: [] }],
      images: [{ ...base.images[0]!, alt: null, hasStableDimensions: false }],
      links: [{ ...base.links[0]!, rawHref: '', href: '', accessibleName: '' }],
    });
    expect(runRule('media.json-ld', snapshot).status).toBe('failure');
    expect(runRule('media.image-alt', snapshot).status).toBe('warning');
    expect(runRule('links.valid-hrefs', snapshot).status).toBe('warning');
  });

  it('uses FCP as the stable paint metric and excludes INP from page scoring', () => {
    const result = runRule('performance.fcp', healthySnapshot({
      performance: { lcp: 1300, cls: 0.02, fcp: 3200, ttfb: 260 },
    }));
    expect(result.status).toBe('failure');
    expect(AUDIT_RULES.some((rule) => rule.id === 'performance.inp')).toBe(false);
  });

  it('infers article and category contexts without scan settings', () => {
    const article = healthySnapshot({
      jsonLd: [{ ...healthySnapshot().jsonLd[0]!, types: ['BlogPosting'] }],
    });
    const category = healthySnapshot({
      jsonLd: [],
      links: [{ ...healthySnapshot().links[0]!, rel: ['next'] }],
    });
    expect(inferAuditContext(article).pageType).toBe('article');
    expect(inferAuditContext(category).pageType).toBe('category');
  });

  it('removes visible body samples before the report enters session storage', () => {
    const report = buildAuditReport(healthySnapshot(), 7);
    expect(report.snapshot.visibleTextPreview).toBe('');
    expect(report.url).toBe('https://example.com/services/seo');
  });
});
