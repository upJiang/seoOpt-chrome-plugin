import { describe, expect, it } from 'vitest';

import { buildAuditReport } from '../src/lib/audit/rules';
import {
  EMPTY_RESPONSE_HEADERS,
  assessCache,
  assessCompression,
  buildCrawlerAccess,
  buildSchemaSuggestions,
  buildSiteEntryUrls,
  evaluateTransport,
  summarizeLinkRels,
  summarizeResources,
} from '../src/lib/audit/technical';
import { parseRobotsPolicy } from '../src/lib/audit/robots';
import type { RedirectVariantResult, ResourceSnapshot, TechnicalDeliveryProbe } from '../src/lib/audit/types';
import { healthySnapshot } from './fixtures/snapshots';

function variant(requestedUrl: string, finalUrl: string, overrides: Partial<RedirectVariantResult> = {}): RedirectVariantResult {
  return {
    requestedUrl,
    finalUrl,
    status: 200,
    redirectCount: requestedUrl === finalUrl ? 0 : 1,
    chain: [],
    chainComplete: true,
    error: null,
    ...overrides,
  };
}

function resource(overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
  return {
    url: 'https://example.com/assets/app.js',
    kind: 'script',
    async: false,
    defer: false,
    module: false,
    blocking: true,
    inline: false,
    inHead: true,
    transferSize: 1200,
    encodedBodySize: 1200,
    decodedBodySize: 5000,
    duration: 20,
    thirdParty: false,
    ...overrides,
  };
}

describe('site entry and transport checks', () => {
  it('uses the public suffix instead of assuming the final hostname segment is the domain', () => {
    expect(buildSiteEntryUrls('https://example.com.cn/products')).toEqual([
      'http://example.com.cn/',
      'https://example.com.cn/',
      'http://www.example.com.cn/',
      'https://www.example.com.cn/',
    ]);
    expect(buildSiteEntryUrls('https://www.example.co.uk/guide')).toHaveLength(4);
    expect(buildSiteEntryUrls('https://shop.example.com/product')).toEqual([
      'http://shop.example.com/',
      'https://shop.example.com/',
    ]);
    expect(buildSiteEntryUrls('http://localhost:3000')).toEqual([]);
    expect(buildSiteEntryUrls('http://127.0.0.1')).toEqual([]);
  });

  it('recognizes convergence, HTTPS downgrade and redirect loops', () => {
    const goodVariants = buildSiteEntryUrls('https://www.example.com').map((url) => variant(url, 'https://www.example.com/'));
    expect(evaluateTransport({ url: 'https://www.example.com/', preferredHost: 'www.example.com', hsts: true, mixedContentUrls: [], variants: goodVariants }).status).toBe('good');
    expect(evaluateTransport({ url: 'https://example.com/', preferredHost: 'example.com', hsts: false, mixedContentUrls: [], variants: [variant('https://example.com/', 'http://example.com/')] }).status).toBe('attention');
    expect(evaluateTransport({ url: 'https://example.com/', preferredHost: 'example.com', hsts: true, mixedContentUrls: [], variants: [variant('https://example.com/', 'https://example.com/', { status: null, error: '检测到循环跳转' })] }).status).toBe('attention');
  });
});

describe('delivery headers and resources', () => {
  it('applies compression only to meaningful text responses', () => {
    expect(assessCompression('text/html', { ...EMPTY_RESPONSE_HEADERS, contentEncoding: 'br', contentLength: 5000 }).status).toBe('good');
    expect(assessCompression('application/javascript', { ...EMPTY_RESPONSE_HEADERS, contentLength: 5000 }).status).toBe('attention');
    expect(assessCompression('image/webp', { ...EMPTY_RESPONSE_HEADERS, contentLength: 5000 }).applicable).toBe(false);
    expect(assessCompression('text/css', { ...EMPTY_RESPONSE_HEADERS, contentLength: 500 }).status).toBe('good');
  });

  it('distinguishes immutable versioned assets, HTML revalidation and stale unversioned assets', () => {
    expect(assessCache('https://example.com/app.abcdef123.js', 'application/javascript', { ...EMPTY_RESPONSE_HEADERS, cacheControl: 'public, max-age=31536000, immutable' }).policy).toBe('long_immutable');
    expect(assessCache('https://example.com/', 'text/html', { ...EMPTY_RESPONSE_HEADERS, cacheControl: 'no-cache', etag: 'abc' }).policy).toBe('revalidate');
    expect(assessCache('https://example.com/app.js', 'application/javascript', { ...EMPTY_RESPONSE_HEADERS, cacheControl: 'public, max-age=31536000' }).status).toBe('confirm');
  });

  it('keeps module and async/defer semantics in resource evidence and treats zero size as unmeasurable', () => {
    const summary = summarizeResources([
      resource(),
      resource({ url: 'https://example.com/assets/app.js', blocking: false, module: true, transferSize: 0 }),
      resource({ url: 'https://cdn.example.net/analytics.js', async: true, blocking: false, thirdParty: true }),
    ]);
    expect(summary.blockingScripts).toBe(1);
    expect(summary.duplicateUrls).toEqual(['https://example.com/assets/app.js']);
    expect(summary.thirdParty).toBe(1);
    expect(summary.unmeasurableSizes).toBe(1);
  });
});

describe('robots, links and schema', () => {
  it('compares common crawler groups and reports syntax, unknown directives and blocked assets', () => {
    const policy = parseRobotsPolicy(
      'https://example.com/robots.txt',
      [
        'Disallow: /before-group',
        'User-agent: *',
        'Disallow: /assets/',
        'User-agent: Googlebot',
        'Allow: /assets/',
        'Disallow: /private/',
        'Mystery-rule: yes',
      ].join('\n'),
      'https://example.com/private/page',
      'Googlebot',
      ['https://example.com/assets/app.css', 'https://example.com/assets/app.js'],
    );
    expect(policy.allowed).toBe(false);
    expect(policy.agentAccess.Googlebot).toBe(false);
    expect(policy.agentAccess.Bingbot).toBe(true);
    expect(policy.syntaxIssues[0]).toContain('User-agent');
    expect(policy.unknownDirectives).toEqual(['mystery-rule']);
    expect(policy.blockedResources).toHaveLength(2);
    expect(policy.blockedResources[0]?.blockedFor).toEqual(expect.arrayContaining(['*', 'Bingbot', 'Baiduspider']));
  });

  it('separates internal nofollow, paid/user relationships and page-level nofollow', () => {
    const links = healthySnapshot().links;
    const summary = summarizeLinkRels([
      ...links,
      { ...links[0]!, href: 'https://example.com/private', rel: ['nofollow'] },
      { ...links[0]!, href: 'https://partner.test', isInternal: false, rel: ['sponsored', 'nofollow'] },
      { ...links[0]!, href: 'https://community.test', isInternal: false, rel: ['ugc'] },
    ], ['index,nofollow']);
    expect(summary).toMatchObject({ internalNofollow: 1, externalNofollow: 1, sponsored: 1, ugc: 1, pageNofollow: true });
  });

  it('suggests schemas only when they match the inferred page type and never invents facts', () => {
    const product = buildSchemaSuggestions('product', []);
    expect(product.map((item) => item.schemaType)).toEqual(expect.arrayContaining(['Product', 'BreadcrumbList']));
    expect(product.find((item) => item.schemaType === 'Product')?.warnings.join('')).toContain('不要创建');
    expect(buildSchemaSuggestions('article', ['Article']).map((item) => item.schemaType)).not.toContain('Article');
  });
});

describe('score boundary', () => {
  it('keeps technical delivery findings outside the existing 100-point score', () => {
    const snapshot = healthySnapshot();
    const baseline = buildAuditReport(snapshot, 1);
    const resources = summarizeResources([resource()]);
    const technical: TechnicalDeliveryProbe = {
      checkedAt: new Date().toISOString(),
      headers: { ...EMPTY_RESPONSE_HEADERS, contentLength: 5000 },
      transport: evaluateTransport({ url: snapshot.url, preferredHost: 'example.com', hsts: false, mixedContentUrls: [] }),
      compression: assessCompression('text/html', { ...EMPTY_RESPONSE_HEADERS, contentLength: 5000 }),
      cache: assessCache(snapshot.url, 'text/html', EMPTY_RESPONSE_HEADERS),
      resources,
      links: summarizeLinkRels(snapshot.links, snapshot.robotsMeta),
      crawler: buildCrawlerAccess(snapshot),
      schemaSuggestions: [],
      limitations: [],
    };
    const withTechnicalIssues = buildAuditReport({ ...snapshot, technical }, 1);
    expect(withTechnicalIssues.findings.filter((item) => item.ruleId.startsWith('technical.')).every((item) => item.points === 0)).toBe(true);
    expect(withTechnicalIssues.overallScore).toBe(baseline.overallScore);
  });
});
