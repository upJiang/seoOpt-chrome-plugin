import { afterEach, describe, expect, it, vi } from 'vitest';

import { gzipSync } from 'node:zlib';

import { aggregateSiteIssues, buildInternalLinkOpportunities, buildSiteInventorySummary, runSiteAudit } from '../src/lib/site-audit/scanner';
import { getSiteIssueGuidance } from '../src/lib/site-audit/guidance';
import { classifyUrlTemplate, validateJsonLd } from '../src/lib/seo/semantic';
import type { SitePageRecord } from '../src/lib/projects/types';

function page(overrides: Partial<SitePageRecord> = {}): SitePageRecord {
  return {
    id: crypto.randomUUID(), runId: 'run', projectId: 'project', url: 'https://example.com/a', finalUrl: 'https://example.com/a', status: 200, contentType: 'text/html', title: '标题', description: '描述', robots: [], canonical: 'https://example.com/a', h1: ['标题'], textLength: 300, contentFingerprint: 'same', internalLinks: [], hreflangs: [], inSitemap: true, allowedByRobots: true, redirectCount: 0, error: null, fetchedAt: '2026-08-01T00:00:00.000Z', ...overrides,
  };
}

describe('site audit sampling', () => {
  afterEach(() => vi.restoreAllMocks());

  it('adds guidance when an older stored issue has no guidance fields', () => {
    const guidance = getSiteIssueGuidance({ code: 'site.canonical' });
    expect(guidance.impact).toContain('合并到目标 URL');
    expect(guidance.recommendation).toContain('指向自身');
    expect(guidance.verification).toContain('目标返回 200');
  });

  it('marks duplicate and orphan findings as sampled candidates', () => {
    const issues = aggregateSiteIssues([
      page(),
      page({ id: 'b', url: 'https://example.com/b', finalUrl: 'https://example.com/b', canonical: 'https://example.com/b' }),
    ]);
    const duplicateTitle = issues.find((item) => item.code === 'site.duplicate-title');
    expect(duplicateTitle?.sampled).toBe(true);
    expect(duplicateTitle?.impact).toContain('难以区分页面用途');
    expect(duplicateTitle?.recommendation).toContain('页面自己的主题');
    expect(duplicateTitle?.verification).toContain('重新检查');
    expect(issues.find((item) => item.code === 'site.orphan-candidate')?.confidence).toBe('low');
  });

  it('aggregates delivery, nofollow and site-entry evidence without mixing it into page scoring', () => {
    const issues = aggregateSiteIssues([
      page({
        compressionStatus: 'attention',
        compressionExplanation: '文本响应超过 1KB，但没有发现 gzip 或 Brotli 响应头。',
        cacheStatus: 'confirm',
        cacheExplanation: 'HTML 使用超过 1 天的公共缓存，需要确认页面是否长期静态以及 CDN 更新策略。',
        nofollowInternalCount: 2,
        crawlerAccessStatus: 'confirm',
      }),
    ], undefined, undefined, [{
      requestedUrl: 'http://example.com/',
      finalUrl: 'http://example.com/',
      status: 200,
      redirectCount: 0,
      chain: [],
      chainComplete: true,
      error: null,
    }]);
    expect(issues.map((item) => item.code)).toEqual(expect.arrayContaining(['site.compression', 'site.cache', 'site.nofollow', 'site.entry']));
    expect(issues.find((item) => item.code === 'site.entry')?.recommendation).toContain('正式 HTTPS 主机');
  });

  it('obeys robots and prioritizes sitemap URLs without leaving the origin', async () => {
    const responses = new Map<string, Response>([
      ['https://example.com/robots.txt', new Response('User-agent: *\nDisallow: /private\nSitemap: https://example.com/sitemap.xml', { status: 200 })],
      ['https://example.com/sitemap.xml', new Response('<?xml version="1.0"?><urlset><url><loc>https://example.com/a</loc></url><url><loc>https://other.example/out</loc></url><url><loc>https://example.com/private</loc></url></urlset>', { status: 200 })],
      ['https://example.com/', new Response('<html><title>Home</title><body><a href="/b">B</a></body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })],
      ['https://example.com/a', new Response('<html><title>A</title><body>Content</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })],
      ['https://example.com/b', new Response('<html><title>B</title><body>Content</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })],
    ]);
    const fetchMock = vi.fn(async (url: string | URL) => responses.get(String(url)) ?? new Response('missing', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const { run, pages } = await runSiteAudit({ projectId: 'project', origin: 'https://example.com', limit: 20 });
    expect(run.status).toBe('completed');
    expect(pages.some((item) => item.url === 'https://example.com/private' && item.allowedByRobots === false)).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('https://other.example'))).toBe(false);
  });

  it('reads a sitemap index, decompresses gzip children and reports invalid lastmod', async () => {
    const child = gzipSync(Buffer.from('<?xml version="1.0"?><urlset><url><loc>https://example.com/article/a</loc><lastmod>2026-99-99</lastmod></url></urlset>'));
    const responses = new Map<string, Response>([
      ['https://example.com/robots.txt', new Response('Sitemap: https://example.com/sitemap-index.xml', { status: 200 })],
      ['https://example.com/sitemap-index.xml', new Response('<sitemapindex><sitemap><loc>https://example.com/posts.xml.gz</loc><lastmod>2026-08-01</lastmod></sitemap></sitemapindex>', { status: 200 })],
      ['https://example.com/posts.xml.gz', new Response(child, { status: 200, headers: { 'Content-Type': 'application/gzip' } })],
      ['https://example.com/', new Response('<html><title>首页</title><body>首页提供足够正文，帮助用户浏览文章分类和产品服务。</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })],
      ['https://example.com/article/a', new Response('<html><title>文章 A</title><body>文章正文包含搜索优化策略、页面规划、技术检查与复测方法，内容足以形成独立页面。</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })],
    ]);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => responses.get(String(url)) ?? new Response('missing', { status: 404 })));
    const { run, pages } = await runSiteAudit({ projectId: 'project', origin: 'https://example.com', limit: 20 });
    expect(pages.some((item) => item.url === 'https://example.com/article/a' && item.inSitemap)).toBe(true);
    expect(run.inventory?.sitemap).toMatchObject({ discovered: true, childCount: 1, compressedFiles: 1, invalidLastmod: 1 });
    expect(run.issues.some((item) => item.code === 'site.sitemap-lastmod' && item.recommendation)).toBe(true);
  });

  it('captures structured data before scripts are removed from visible text', async () => {
    const html = `<html><head><title>SEO 实战</title><script type="application/ld+json">{"@type":"Article","headline":"另一个标题","datePublished":"昨天","author":{"@type":"Person","name":"作者"}}</script></head><body><main>这是一篇包含充分正文内容的 SEO 实战文章，用于验证结构化数据和可见页面内容是否保持一致。</main></body></html>`;
    const responses = new Map<string, Response>([
      ['https://example.com/robots.txt', new Response('', { status: 200 })],
      ['https://example.com/sitemap.xml', new Response('<urlset><url><loc>https://example.com/</loc></url></urlset>', { status: 200 })],
      ['https://example.com/', new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })],
    ]);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => responses.get(String(url)) ?? new Response('missing', { status: 404 })));
    const { run, pages } = await runSiteAudit({ projectId: 'project', origin: 'https://example.com', limit: 20 });
    expect(pages[0]?.jsonLdTypes).toContain('Article');
    expect(pages[0]?.jsonLdIssues).toContain('datePublished 不是标准 ISO 日期');
    expect(run.issues.some((item) => item.code === 'site.schema-semantic')).toBe(true);
  });

  it('identifies pagination, indexable search pages, hreflang errors and near duplicates as sampled findings', () => {
    expect(classifyUrlTemplate('https://example.com/catalog?page=2').type).toBe('pagination');
    expect(classifyUrlTemplate('https://example.com/blog/seo-guide').key).toBe(classifyUrlTemplate('https://example.com/blog/technical-seo').key);
    expect(classifyUrlTemplate('https://example.com/products/red-shoes').key).toBe(classifyUrlTemplate('https://example.com/products/blue-shoes').key);
    const pages = [
      page({ url: 'https://example.com/catalog', finalUrl: 'https://example.com/catalog', internalLinks: ['https://example.com/catalog?page=2'], language: 'zh-CN', hreflangs: [{ lang: 'zh-CN', href: 'https://example.com/catalog' }, { lang: 'en', href: 'https://example.com/en/catalog' }] }),
      page({ id: 'p2', url: 'https://example.com/catalog?page=2', finalUrl: 'https://example.com/catalog?page=2', canonical: 'https://example.com/catalog', canonicalResolved: 'https://example.com/catalog', isPaginationPage: true, pageType: 'pagination', templateKey: 'pagination:/catalog', nearDuplicateFingerprint: '00000000' }),
      page({ id: 'search', url: 'https://example.com/search?q=seo', finalUrl: 'https://example.com/search?q=seo', canonical: 'https://example.com/search?q=seo', isSearchPage: true, pageType: 'search', templateKey: 'search:/search', nearDuplicateFingerprint: '00000001' }),
      page({ id: 'en', url: 'https://example.com/en/catalog', finalUrl: 'https://example.com/en/catalog', canonical: 'https://example.com/en/catalog', language: 'en', hreflangs: [{ lang: 'en', href: 'https://example.com/en/catalog' }] }),
    ];
    const issues = aggregateSiteIssues(pages);
    expect(issues.some((item) => item.code === 'site.pagination-canonical')).toBe(true);
    expect(issues.some((item) => item.code === 'site.search-indexable')).toBe(true);
    expect(issues.some((item) => item.code === 'site.hreflang-reciprocal')).toBe(true);
    expect(issues.some((item) => item.code === 'site.near-duplicate')).toBe(true);
  });

  it('builds local internal-link opportunities with a source, target and natural anchor candidate', () => {
    const pages = [
      page({ url: 'https://example.com/guide', finalUrl: 'https://example.com/guide', title: 'SEO 优化指南', h1: ['SEO 优化指南'], internalLinks: [], incomingLinkCount: 2, contentTerms: ['seo', '优化', '指南'] }),
      page({ id: 'technical', url: 'https://example.com/technical-seo', finalUrl: 'https://example.com/technical-seo', title: '技术 SEO 检查', h1: ['技术 SEO 检查'], internalLinks: [], incomingLinkCount: 0, contentTerms: ['seo', '优化', '技术'] }),
      page({ id: 'ads', url: 'https://example.com/sem', finalUrl: 'https://example.com/sem', title: 'SEM', h1: ['SEM'], internalLinks: [], incomingLinkCount: 3, contentTerms: ['广告', '预算'] }),
    ];
    const opportunities = buildInternalLinkOpportunities(pages);
    expect(opportunities.find((item) => item.targetUrl === 'https://example.com/technical-seo')).toMatchObject({ sourceUrl: 'https://example.com/guide', suggestedAnchor: '技术 SEO 检查', confidence: 'low' });
  });

  it('validates article, product and organization schema semantics', () => {
    const article = validateJsonLd({ '@type': 'Article', headline: '文章', datePublished: '2026-13-40', dateModified: 'not-a-date', author: { '@type': 'Person', name: '作者' } }, { title: '文章' });
    expect(article.issues.map((item) => item.code)).toEqual(expect.arrayContaining(['date-published-format', 'date-modified-format', 'article-image']));
    const product = validateJsonLd({ '@type': 'Product', name: '商品', offers: { price: '-1', priceCurrency: 'rmb', availability: 'maybe' } }, { title: '商品' });
    expect(product.issues.map((item) => item.code)).toEqual(expect.arrayContaining(['product-price-format', 'product-currency-format', 'product-availability-format']));
    const organization = validateJsonLd({ '@type': 'Organization', name: 'Example' });
    expect(organization.issues.map((item) => item.code)).toEqual(expect.arrayContaining(['missing-url', 'organization-logo']));
  });
});
