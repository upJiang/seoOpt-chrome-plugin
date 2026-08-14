import { describe, expect, it } from 'vitest';

import { buildAuditReport } from '../src/lib/audit/rules';
import { buildOptimizationRecommendations, buildRecommendationSections, getExpectedOutcome } from '../src/lib/audit/recommendations';
import { buildOverseasStaticSnapshot } from '../src/lib/overseas/diagnostics';
import { finding, healthySnapshot } from './fixtures/snapshots';

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

  it('uses the final current URL for Canonical code and removes tracking parameters', () => {
    const report = buildAuditReport(healthySnapshot({
      url: 'https://example.com/services/seo?utm_source=ad&gclid=secret&variant=a#details',
      siteProbe: {
        ...healthySnapshot().siteProbe,
        page: { ...healthySnapshot().siteProbe.page, finalUrl: 'https://www.example.com/services/seo?utm_source=ad&variant=a#details' },
      },
    }), 9);
    report.findings = [finding({
      id: 'canonical',
      ruleId: 'discoverability.canonical',
      rootCauseId: 'canonical',
      category: 'discoverability',
      status: 'warning',
      priority: 'P2',
    })];

    const recommendation = buildOptimizationRecommendations(report)[0]!;
    expect(recommendation.implementationRecipes[0]?.variant.code).toContain('https://www.example.com/services/seo?variant=a');
    expect(recommendation.implementationRecipes[0]?.variant.code).not.toContain('utm_source');
    expect(recommendation.implementationRecipes[0]?.variant.code).not.toContain('gclid');
    expect(recommendation.expectedDirectResult).not.toBe(recommendation.possibleSearchEffect);
    expect(recommendation.notGuaranteed).toContain('不能保证');
  });

  it('merges a shared root cause and preserves every piece of evidence', () => {
    const report = buildAuditReport(healthySnapshot(), 9);
    report.findings = [
      finding({ id: 'title', ruleId: 'metadata.title', rootCauseId: 'page-promise', title: 'Title 不清楚', status: 'failure', priority: 'P1' }),
      finding({ id: 'h1', ruleId: 'metadata.h1', rootCauseId: 'page-promise', title: 'H1 缺失', status: 'warning', priority: 'P2' }),
    ];

    const recommendation = buildOptimizationRecommendations(report)[0]!;
    expect(recommendation.findings).toHaveLength(2);
    expect(recommendation.evidence.map((item) => item.findingId)).toEqual(['title', 'h1']);
    expect(recommendation.strategy.resolves).toEqual(['Title 不清楚', 'H1 缺失']);
  });

  it('shows detected framework code as an additional variant without hiding final HTML', () => {
    const report = buildAuditReport(healthySnapshot({
      technology: { primary: 'nextjs', confidence: 'high', signals: [{ stack: 'nextjs', confidence: 'high', evidence: '检测到 /_next/ 资源。' }] },
    }), 9);
    report.findings = [finding({ id: 'title', ruleId: 'metadata.title', rootCauseId: 'title', status: 'failure', priority: 'P1' })];

    const recipes = buildOptimizationRecommendations(report)[0]!.implementationRecipes;
    expect(recipes[0]?.applicableTechnology).toBe('最终 HTML 或通用模板');
    expect(recipes[1]?.applicableTechnology).toContain('Next.js');
    expect(recipes[1]?.variant.code).toContain('Metadata');
  });

  it('does not invent commercial facts in Schema examples', () => {
    const report = buildAuditReport(healthySnapshot(), 9);
    report.findings = [finding({ id: 'schema', ruleId: 'media.json-ld', rootCauseId: 'schema', category: 'media', status: 'warning' })];

    const code = buildOptimizationRecommendations(report)[0]!.implementationRecipes[0]!.variant.code!;
    expect(code).toContain('WebPage');
    expect(code).not.toMatch(/price|rating|availability|author/i);
  });

  it('routes international evidence to the international filter with current-page URLs', () => {
    const snapshot = healthySnapshot({ htmlLang: 'en-US' });
    snapshot.overseas = buildOverseasStaticSnapshot(snapshot, {
      targetCountry: 'France', targetLanguage: 'fr-FR', searchEngine: 'google', useGoogleAds: false, useMicrosoftAds: false, conversionDomains: [],
    }, { scriptUrls: [], inlineScriptText: [], resourceUrls: [], dataLayerEntries: [], uetEntries: [], currentUrl: snapshot.url, finalUrl: snapshot.url });
    const report = buildAuditReport(snapshot, 9);

    const recommendation = buildOptimizationRecommendations(report).find((item) => item.category === 'international');
    expect(recommendation).toBeDefined();
    expect(recommendation?.implementationRecipes[0]?.variant.code).toContain('https://example.com/services/seo');
    expect(recommendation?.implementationRecipes[0]?.variant.code).not.toContain('https://example.com/en-us/page');
    expect(recommendation?.implementationRecipes[0]?.placeholders.map((item) => item.token)).toContain('{{ALTERNATE_PAGE_URL}}');
  });

  it('routes static tracking evidence to the tracking filter', () => {
    const snapshot = healthySnapshot();
    snapshot.overseas = buildOverseasStaticSnapshot(snapshot, {
      targetCountry: '', targetLanguage: '', searchEngine: 'google', useGoogleAds: false, useMicrosoftAds: false, conversionDomains: [],
    }, {
      scriptUrls: ['https://www.googletagmanager.com/gtag/js?id=UA-123456-1'], inlineScriptText: [], resourceUrls: [], dataLayerEntries: [['config', 'UA-123456-1']], uetEntries: [], currentUrl: snapshot.url, finalUrl: snapshot.url,
    });
    const report = buildAuditReport(snapshot, 9);

    const recommendation = buildOptimizationRecommendations(report).find((item) => item.category === 'tracking');
    expect(recommendation?.title).toContain('Universal Analytics');
    expect(recommendation?.implementationRecipes[0]?.placeholders.map((item) => item.token)).toContain('G-XXXXXXX');
  });
});
