import { describe, expect, it } from 'vitest';

import { normalizeCsvRows, parseCsvPreview } from '../src/lib/imports/csv';
import {
  buildOverseasStaticSnapshot,
  buildOverseasSummary,
  buildTrackingTestConclusion,
  diagnoseOverseasStatic,
  finalizeTrackingRun,
  normalizeTrackingPage,
  reconcileTrackingData,
  sanitizeTrackingObservation,
  validateTrackingObservation,
} from '../src/lib/overseas/diagnostics';
import { buildOverseasOptimizationRecommendations } from '../src/lib/audit/recommendations';
import { buildAuditReport } from '../src/lib/audit/rules';
import { parseHreflangTargetHtml } from '../src/lib/overseas/hreflang-parser';
import type { AnalyticsPerformanceRow, BusinessOutcomeRow, InternationalProjectSettings, SemPerformanceRow, TrackingObservation, TrackingTestRun } from '../src/lib/projects/types';
import { healthySnapshot } from './fixtures/snapshots';

const settings: InternationalProjectSettings = {
  targetCountry: 'United States', targetLanguage: 'en-US', searchEngine: 'both', useGoogleAds: true, useMicrosoftAds: true, conversionDomains: [],
};

function observation(overrides: Partial<TrackingObservation> = {}): TrackingObservation {
  return {
    id: crypto.randomUUID(), platform: 'google_analytics', type: 'event', name: 'purchase', relativeMs: 1_000,
    fields: { eventId: false, transactionId: true, value: true, currency: true, items: true, sensitiveField: false },
    ...overrides,
  };
}

describe('overseas static diagnosis', () => {
  it('treats a single-language page without hreflang as normal when no target language was entered', () => {
    const page = healthySnapshot({
      htmlLang: 'en',
      visibleTextLength: 600,
      visibleTextPreview: 'This is an English website for customers who need product documentation and support.'.repeat(8),
      hreflangs: [],
    });
    const noTargetSettings = { ...settings, targetLanguage: '', useGoogleAds: false, useMicrosoftAds: false };
    const snapshot = buildOverseasStaticSnapshot(page, noTargetSettings, {
      scriptUrls: [], inlineScriptText: [], resourceUrls: [], dataLayerEntries: [], uetEntries: [], currentUrl: page.url, finalUrl: page.url,
    });
    const summary = buildOverseasSummary({ snapshot: page, staticSnapshot: snapshot, settings: noTargetSettings });
    expect(snapshot.internationalSeo.status).toBe('normal');
    expect(summary.normalItems.find((item) => item.id === 'overseas:normal:language')?.evidence).toContain('不需要设置 hreflang');
    expect(summary.issues).toHaveLength(0);
    expect(summary.opportunities.map((item) => item.id)).toContain('overseas:international:localized-pages-opportunity');
    expect(summary.googleAds).toMatchObject({ applicable: false, status: 'normal' });
  });

  it('describes a public redirect or error as a medium-confidence access risk without blocking DOM conclusions', () => {
    const page = healthySnapshot({
      url: 'https://www.relebook.com/',
      origin: 'https://www.relebook.com',
      htmlLang: 'en',
      visibleTextLength: 1200,
      visibleTextPreview: 'English project management documentation and product guidance.'.repeat(10),
      siteProbe: {
        ...healthySnapshot().siteProbe,
        page: { status: 404, finalUrl: 'https://pic.relebook.com/404.html', contentType: 'text/html', xRobotsTag: '', error: null },
      },
    });
    const noTargetSettings = { ...settings, targetLanguage: '', useGoogleAds: false, useMicrosoftAds: false };
    const snapshot = buildOverseasStaticSnapshot(page, noTargetSettings, {
      scriptUrls: [], inlineScriptText: [], resourceUrls: [], dataLayerEntries: [], uetEntries: [], currentUrl: page.url, finalUrl: page.siteProbe.page.finalUrl,
    });
    const summary = buildOverseasSummary({ snapshot: page, staticSnapshot: snapshot, settings: noTargetSettings });
    expect(summary.searchAccess).toMatchObject({ status: 'attention', confidence: 'medium' });
    expect(summary.searchAccess.developerMessage).toContain('pic.relebook.com/404.html');
    expect(summary.issues[0]).toMatchObject({ id: 'overseas:search:public-access-mismatch', kind: 'issue', category: 'search_access' });
    expect(summary.normalItems.map((item) => item.id)).toContain('overseas:normal:readable-content');
    expect(summary.googleSearch.indexedExplanation).toContain('Search Console');
  });

  it('detects Google/Bing tags, UET IDs, Consent order and old UA safely', () => {
    const page = healthySnapshot({ htmlLang: 'en-US', visibleTextPreview: 'SEO services for businesses in the United States. Price USD 99. Call +1 (555) 123-4567.' });
    const snapshot = buildOverseasStaticSnapshot(page, settings, {
      scriptUrls: ['https://www.googletagmanager.com/gtag/js?id=G-ABC123', 'https://www.googletagmanager.com/gtm.js?id=GTM-TEST', 'https://bat.bing.com/bat.js'],
      inlineScriptText: ["gtag('config','UA-12345-1'); window.uetq=[{ti:'1234567'}]"],
      resourceUrls: ['https://www.google-analytics.com/g/collect?tid=G-ABC123', 'https://bat.bing.com/action/0?ti=1234567'],
      dataLayerEntries: [
        ['consent', 'default', { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' }],
        ['config', 'G-ABC123', {}],
        ['consent', 'update', { analytics_storage: 'granted' }],
      ],
      uetEntries: [{ event: 'page_view' }], currentUrl: page.url, finalUrl: page.url,
    });

    expect(snapshot.tags.find((item) => item.platform === 'bing_uet')?.ids).toContain('1234567');
    expect(snapshot.tags.find((item) => item.platform === 'google_analytics')).toMatchObject({ requestObserved: true, oldUniversalAnalytics: true });
    expect(snapshot.consent).toMatchObject({ defaultSeen: true, updateSeen: true, orderValid: true });
    expect(snapshot.consent.signals.analytics_storage).toBe('granted');
    expect(snapshot.internationalSeo.regionalSignals).toMatchObject({ currencyCodes: ['USD'], phoneCountryCodes: ['+1'] });
  });

  it('surfaces international, Google verification and tracking failures in the plain summary', () => {
    const page = healthySnapshot({
      htmlLang: 'en',
      visibleTextLength: 800,
      visibleTextPreview: 'English product documentation for international customers.'.repeat(10),
      hreflangs: [
        { lang: 'en-US', href: 'https://example.com/en/', valid: true, locator: { segments: ['link[hreflang="en-US"]'] } },
        { lang: 'fr-FR', href: 'https://example.com/fr/', valid: true, locator: { segments: ['link[hreflang="fr-FR"]'] } },
      ],
    });
    const internationalSettings = { ...settings, targetLanguage: 'fr-FR', useGoogleAds: false, useMicrosoftAds: false };
    const snapshot = buildOverseasStaticSnapshot(page, internationalSettings, {
      scriptUrls: [], inlineScriptText: [], resourceUrls: [], dataLayerEntries: [], uetEntries: [], currentUrl: page.url, finalUrl: page.url,
    });
    const failedRun: TrackingTestRun = {
      id: 'failed', projectId: 'project', startedAt: '2026-08-01T00:00:00Z', endedAt: null, goal: 'lead', status: 'stopped', stages: [], duplicateEvents: [], sensitiveFieldNames: [], limitations: [],
      observations: [
        observation({ id: 'success', platform: 'browser', name: 'user_confirmed_success', relativeMs: 1_500 }),
        observation({ id: 'bad', platform: 'google_tag_manager', name: 'generate_lead', relativeMs: 2_000 }),
        observation({ id: 'failure', platform: 'browser', name: 'user_confirmed_failure', relativeMs: 2_500 }),
      ],
      successfulActionObserved: true, failedActionObserved: true,
    };
    const summary = buildOverseasSummary({
      snapshot: page, staticSnapshot: snapshot, settings: internationalSettings, trackingRun: failedRun,
      googleVerification: { pageUrl: page.url, result: 'issue', confirmedAt: '2026-08-01T00:01:00Z' },
    });
    expect(summary.issues.map((item) => item.id)).toEqual(expect.arrayContaining([
      'overseas:search:google-live-test-issue', 'overseas:tracking:test-failed',
    ]));
    expect(summary.issues.map((item) => item.title)).toEqual(expect.arrayContaining([expect.stringContaining('目标语言')]));
    expect(summary.issueCount).toBe(summary.issues.length);
  });

  it('recognizes Google Ads conversion requests independently from GA4 collect', () => {
    const page = healthySnapshot({ htmlLang: 'en-US' });
    const snapshot = buildOverseasStaticSnapshot(page, settings, {
      scriptUrls: ['https://www.googletagmanager.com/gtag/js?id=AW-123456789'],
      inlineScriptText: [],
      resourceUrls: ['https://www.googleadservices.com/pagead/conversion/123456789/?label=test'],
      dataLayerEntries: [['config', 'AW-123456789', {}]],
      uetEntries: [], currentUrl: page.url, finalUrl: page.url,
    });
    expect(snapshot.tags.find((item) => item.platform === 'google_ads')).toMatchObject({ ids: ['AW-123456789'], initialized: true, requestObserved: true });
  });

  it('parses hreflang target HTML without depending on attribute order', () => {
    const parsed = parseHreflangTargetHtml(`<!doctype html><html data-site="x" lang="fr-FR"><head>
      <link href="/fr/page" data-x="1" rel="canonical">
      <meta content="max-snippet:-1, noindex" name="googlebot">
      <link href="https://example.com/en/page?utm_source=test#top" hreflang="en-US" rel="alternate">
    </head></html>`, 'https://example.com/fr/page', 'https://example.com/en/page');
    expect(parsed).toEqual({ canonical: '/fr/page', htmlLang: 'fr-FR', noindex: true, reciprocal: true });
  });

  it('creates complete actions without treating tag presence as platform receipt', () => {
    const page = healthySnapshot({ htmlLang: 'en-US' });
    const snapshot = buildOverseasStaticSnapshot(page, settings, {
      scriptUrls: ['https://www.googletagmanager.com/gtag/js?id=G-ABC123'], inlineScriptText: [], resourceUrls: [], dataLayerEntries: [], uetEntries: [], currentUrl: `${page.url}?gclid=test`, finalUrl: page.url,
    });
    const findings = diagnoseOverseasStatic(snapshot, settings);
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: expect.stringContaining('Google Ads'), priority: 'P1', action: expect.any(String), verification: expect.any(String), platformConfirmation: expect.any(String), rollback: expect.any(String) }),
      expect.objectContaining({ title: expect.stringContaining('UET'), priority: 'P1' }),
      expect.objectContaining({ title: expect.stringContaining('丢失') }),
    ]));
  });

  it('matches the 3d66 single-language baseline with visible opportunities and deduplicated boundaries', () => {
    const url = 'https://www.3d66.com/';
    const page = healthySnapshot({
      url,
      origin: 'https://www.3d66.com',
      htmlLang: 'zh-CN',
      hreflangs: [],
      visibleTextLength: 2400,
      visibleTextPreview: '3D模型、效果图、材质贴图和室内设计资源下载。'.repeat(50),
      siteProbe: {
        ...healthySnapshot().siteProbe,
        page: { ...healthySnapshot().siteProbe.page, status: 200, finalUrl: url },
        robots: { ...healthySnapshot().siteProbe.robots, url: 'https://www.3d66.com/robots.txt', allowed: true },
      },
    });
    const noTargetSettings = { ...settings, targetCountry: '', targetLanguage: '', useGoogleAds: false, useMicrosoftAds: false };
    const staticSnapshot = buildOverseasStaticSnapshot(page, noTargetSettings, {
      scriptUrls: ['https://hm.baidu.com/hm.js?site', 'https://www.clarity.ms/tag/t5fsld502p'],
      inlineScriptText: [],
      resourceUrls: ['https://hm.baidu.com/hm.gif?site', 'https://www.clarity.ms/collect'],
      dataLayerEntries: [], uetEntries: [], currentUrl: url, finalUrl: url,
    });
    const first = buildOverseasSummary({ snapshot: page, staticSnapshot, settings: noTargetSettings });
    const second = buildOverseasSummary({ snapshot: page, staticSnapshot, settings: noTargetSettings });

    expect(first).toMatchObject({ normalCount: 5, issueCount: 0, opportunityCount: 3 });
    expect(first.opportunities.map((item) => item.id)).toEqual([
      'overseas:tracking:measurement-google-bing',
      'overseas:international:localized-pages-opportunity',
      'overseas:business:market-conversion-support',
    ]);
    expect(first.marketAssessment.marketEvidence).toBe('not_observed');
    expect(first.marketAssessment.capabilities.map((item) => item.id)).toEqual([
      'search_access', 'localization', 'measurement', 'advertising', 'business_localization',
    ]);
    expect(first.otherAnalytics.map((item) => item.label)).toEqual(['百度统计', 'Microsoft Clarity']);
    expect(first.evidenceGaps.map((item) => item.id)).toEqual(['overseas:boundary:indexing-ranking', 'overseas:boundary:platform-business']);
    expect(second.opportunities.map((item) => item.id)).toEqual(first.opportunities.map((item) => item.id));
    expect(first.tracking.status).toBe('untested');
  });

  it('keeps domestic currency, phone and date signals from becoming overseas market evidence', () => {
    const page = healthySnapshot({
      htmlLang: 'zh-CN',
      hreflangs: [],
      visibleTextPreview: '国内服务价格 CNY 99，联系电话 +86 010-12345678，更新时间 2026-08-14。'.repeat(20),
    });
    const noTargetSettings = { ...settings, targetCountry: '', targetLanguage: '', useGoogleAds: false, useMicrosoftAds: false };
    const staticSnapshot = buildOverseasStaticSnapshot(page, noTargetSettings, {
      scriptUrls: [], inlineScriptText: [], resourceUrls: [], dataLayerEntries: [], uetEntries: [], currentUrl: page.url, finalUrl: page.url,
    });
    const summary = buildOverseasSummary({ snapshot: page, staticSnapshot, settings: noTargetSettings });

    expect(summary.marketAssessment.marketEvidence).toBe('not_observed');
    expect(summary.marketAssessment.capabilities.find((item) => item.id === 'business_localization')?.state).toBe('unknown');
  });

  it('requires a GA4 data request before marking overseas measurement ready', () => {
    const page = healthySnapshot({ htmlLang: 'en-US', visibleTextPreview: 'Product support for customers in the United States.'.repeat(20) });
    const singleMarketSettings = { ...settings, useGoogleAds: false, useMicrosoftAds: false };
    const gtmOnly = buildOverseasStaticSnapshot(page, singleMarketSettings, {
      scriptUrls: ['https://www.googletagmanager.com/gtm.js?id=GTM-ONLY'],
      inlineScriptText: [], resourceUrls: [], dataLayerEntries: [], uetEntries: [], currentUrl: page.url, finalUrl: page.url,
    });
    const partial = buildOverseasSummary({ snapshot: page, staticSnapshot: gtmOnly, settings: singleMarketSettings });
    expect(partial.marketAssessment.marketEvidence).toBe('partial');
    expect(partial.marketAssessment.capabilities.find((item) => item.id === 'measurement')).toMatchObject({ state: 'partial' });

    const withGa4Request = buildOverseasStaticSnapshot(page, singleMarketSettings, {
      scriptUrls: ['https://www.googletagmanager.com/gtag/js?id=G-MARKET1'],
      inlineScriptText: [], resourceUrls: ['https://www.google-analytics.com/g/collect?tid=G-MARKET1'], dataLayerEntries: [['config', 'G-MARKET1', {}]], uetEntries: [], currentUrl: page.url, finalUrl: page.url,
    });
    const established = buildOverseasSummary({ snapshot: page, staticSnapshot: withGa4Request, settings: singleMarketSettings });
    expect(established.marketAssessment.marketEvidence).toBe('established');
    expect(established.marketAssessment.capabilities.find((item) => item.id === 'measurement')).toMatchObject({ state: 'ready' });
  });

  it('turns a different configured target language into an issue instead of a language expansion opportunity', () => {
    const page = healthySnapshot({ htmlLang: 'zh-CN', hreflangs: [], visibleTextPreview: '中文网站内容和产品服务说明。'.repeat(50) });
    const targetSettings = { ...settings, targetLanguage: 'en-US', useGoogleAds: false, useMicrosoftAds: false };
    const staticSnapshot = buildOverseasStaticSnapshot(page, targetSettings, {
      scriptUrls: [], inlineScriptText: [], resourceUrls: [], dataLayerEntries: [], uetEntries: [], currentUrl: page.url, finalUrl: page.url,
    });
    const summary = buildOverseasSummary({ snapshot: page, staticSnapshot, settings: targetSettings });
    expect(summary.issues.map((item) => item.title)).toContain('页面声明语言 zh-CN 与目标语言 en-US 不一致。');
    expect(summary.opportunities.map((item) => item.id)).not.toContain('overseas:international:localized-pages-opportunity');
  });

  it('keeps target-language and detected-content conflicts as separate stable findings', () => {
    const page = healthySnapshot({
      htmlLang: 'zh-CN',
      hreflangs: [],
      visibleTextPreview: 'English product information, pricing, support and delivery details for international customers.'.repeat(20),
    });
    const targetSettings = { ...settings, targetLanguage: 'en-US', useGoogleAds: false, useMicrosoftAds: false };
    const staticSnapshot = buildOverseasStaticSnapshot(page, targetSettings, {
      scriptUrls: [], inlineScriptText: [], resourceUrls: [], dataLayerEntries: [], uetEntries: [], currentUrl: page.url, finalUrl: page.url,
    });
    const summary = buildOverseasSummary({ snapshot: page, staticSnapshot, settings: targetSettings });
    const languageIssues = summary.issues.filter((item) => item.area === 'localization');

    expect(languageIssues.map((item) => item.id)).toEqual(expect.arrayContaining([
      expect.stringContaining('target_language_mismatch:current:'),
      expect.stringContaining('content_language_mismatch:current:'),
    ]));
    expect(new Set(languageIssues.map((item) => item.id)).size).toBe(languageIssues.length);
  });

  it('recomputes the target language conclusion from current settings without refreshing static evidence', () => {
    const page = healthySnapshot({ htmlLang: 'zh-CN', hreflangs: [], visibleTextPreview: '中文网站内容和产品服务说明。'.repeat(50) });
    const initialSettings = { ...settings, targetLanguage: '', useGoogleAds: false, useMicrosoftAds: false };
    const staticSnapshot = buildOverseasStaticSnapshot(page, initialSettings, {
      scriptUrls: [], inlineScriptText: [], resourceUrls: [], dataLayerEntries: [], uetEntries: [], currentUrl: page.url, finalUrl: page.url,
    });
    const changedSettings = { ...initialSettings, targetLanguage: 'en-US' };
    const summary = buildOverseasSummary({ snapshot: page, staticSnapshot, settings: changedSettings });

    expect(staticSnapshot.internationalSeo.targetLanguage).toBe('');
    expect(summary.issues.map((item) => item.title)).toContain('页面声明语言 zh-CN 与目标语言 en-US 不一致。');
    expect(summary.opportunities.map((item) => item.id)).not.toContain('overseas:international:localized-pages-opportunity');
  });

  it('shows skipped cross-origin related pages as one evidence boundary instead of a website problem', () => {
    const page = healthySnapshot({
      htmlLang: 'en-US',
      hreflangs: [{ lang: 'fr-FR', href: 'https://fr.example.net/page', valid: true, locator: { segments: ['link[hreflang="fr-FR"]'] } }],
    });
    const noAds = { ...settings, targetLanguage: '', useGoogleAds: false, useMicrosoftAds: false };
    const staticSnapshot = buildOverseasStaticSnapshot(page, noAds, { scriptUrls: [], inlineScriptText: [], resourceUrls: [], dataLayerEntries: [], uetEntries: [], currentUrl: page.url, finalUrl: page.url });
    staticSnapshot.internationalSeo.relatedCheck = { checkedAt: '2026-08-14T00:00:00Z', checkedUrls: [], skippedOrigins: ['https://fr.example.net'], status: 'partial' };
    const summary = buildOverseasSummary({ snapshot: page, staticSnapshot, settings: noAds });

    expect(summary.evidenceGaps.filter((item) => item.id === 'overseas:boundary:related-origin-permission')).toHaveLength(1);
    expect(summary.issues.some((item) => item.evidence.includes('fr.example.net'))).toBe(false);
  });

  it('reuses authorized entry evidence and reports a checked TLS failure', () => {
    const page = healthySnapshot({
      technical: {
        checkedAt: '2026-08-14T00:00:00Z',
        headers: { contentEncoding: null, contentLength: null, cacheControl: null, expires: null, etag: null, lastModified: null, vary: null, age: null, strictTransportSecurity: null },
        transport: { status: 'attention', currentProtocol: 'https:', secureContext: true, preferredHost: 'www.3d66.com', hsts: null, mixedContentUrls: [], certificateDetails: 'not_available', explanation: '入口失败', variants: [{ requestedUrl: 'https://3d66.com/', finalUrl: 'https://3d66.com/', status: null, redirectCount: 0, chain: [], chainComplete: false, error: 'TLS handshake failed' }] },
        compression: { status: 'unavailable', applicable: false, encoding: null, bytes: null, explanation: '' },
        cache: { status: 'unavailable', policy: 'unclear', maxAgeSeconds: null, hasValidator: false, explanation: '' },
        resources: { total: 0, blockingScripts: 0, blockingStylesheets: 0, duplicateUrls: [], thirdParty: 0, unmeasurableSizes: 0, transferBytes: null, resources: [] },
        links: { total: 0, internalNofollow: 0, externalNofollow: 0, ugc: 0, sponsored: 0, pageNofollow: false },
        crawler: { status: 'unavailable', confidence: 'low', statusCode: null, robotsAllowed: null, rawHasTitle: null, rawHasH1: null, rawHasMainContent: null, rawHasCanonical: null, rawHasInternalLinks: null, renderDependentFields: [], explanation: '' },
        schemaSuggestions: [], limitations: [],
      },
    });
    const noAds = { ...settings, targetLanguage: '', useGoogleAds: false, useMicrosoftAds: false };
    const staticSnapshot = buildOverseasStaticSnapshot(page, noAds, { scriptUrls: [], inlineScriptText: [], resourceUrls: [], dataLayerEntries: [], uetEntries: [], currentUrl: page.url, finalUrl: page.url });
    expect(buildOverseasSummary({ snapshot: page, staticSnapshot, settings: noAds }).issues.map((item) => item.id)).toContain('overseas:search:host-entry-risk');
  });

  it('promotes a checked mobile alternate without html lang to an international issue', () => {
    const page = healthySnapshot({ alternatePages: [{ kind: 'mobile', href: 'https://m.3d66.com/', media: 'only screen and (max-width: 640px)' }] });
    const noAds = { ...settings, targetLanguage: '', useGoogleAds: false, useMicrosoftAds: false };
    const staticSnapshot = buildOverseasStaticSnapshot(page, noAds, { scriptUrls: [], inlineScriptText: [], resourceUrls: [], dataLayerEntries: [], uetEntries: [], currentUrl: page.url, finalUrl: page.url });
    staticSnapshot.internationalSeo.targets = [{
      kind: 'mobile', lang: '移动版', url: 'https://m.3d66.com/', status: 200, finalUrl: 'https://m.3d66.com/', reciprocal: null, canonical: 'https://www.3d66.com/', noindex: false, htmlLang: '', issue: '移动版本缺少 html lang',
      issues: [{ code: 'missing_lang', targetUrl: 'https://m.3d66.com/', status: 200, finalUrl: 'https://m.3d66.com/', htmlLang: '', canonical: 'https://www.3d66.com/', noindex: false, message: '移动版本缺少 html lang' }],
    }];
    const summary = buildOverseasSummary({ snapshot: page, staticSnapshot, settings: noAds });
    const issue = summary.issues.find((item) => item.title === '移动版本：移动版本缺少 html lang');
    expect(issue?.id).toBe('overseas:international:missing_lang:mobile:https%3A%2F%2Fm.3d66.com%2F');
    expect(issue?.evidence).toContain('检查地址：https://m.3d66.com/');
    expect(issue?.evidence).toContain('响应状态：200');
    expect(issue?.evidence).toContain('页面语言：未声明');
    expect(issue?.evidence).toContain('Canonical：https://www.3d66.com/');
  });
});

describe('tracking privacy and reconciliation', () => {
  it('turns successful and failed user markers into a plain tracking conclusion', () => {
    const run: TrackingTestRun = {
      id: 'guided', projectId: 'project', startedAt: '2026-08-01T00:00:00Z', endedAt: null, goal: 'purchase', status: 'running', stages: [], duplicateEvents: [], sensitiveFieldNames: [], limitations: [],
      observations: [
        observation({ id: 'event', relativeMs: 1_000 }),
        observation({ id: 'success', platform: 'browser', name: 'user_confirmed_success', relativeMs: 1_500 }),
        observation({ id: 'failure', platform: 'browser', name: 'user_confirmed_failure', relativeMs: 20_000 }),
      ],
      successfulActionObserved: true,
      failedActionObserved: true,
    };
    expect(buildTrackingTestConclusion(run)).toMatchObject({ status: 'normal', successfulAction: 'recorded_once', failedAction: 'not_recorded' });
  });

  it('does not treat one Google and one Bing event for the same action as a duplicate', () => {
    const run: TrackingTestRun = {
      id: 'cross-platform', projectId: 'project', startedAt: '2026-08-01T00:00:00Z', endedAt: null, goal: 'lead', status: 'running', stages: [], duplicateEvents: [], sensitiveFieldNames: [], limitations: [],
      observations: [
        observation({ id: 'ga', platform: 'google_tag_manager', name: 'generate_lead', relativeMs: 1_000 }),
        observation({ id: 'uet', platform: 'bing_uet', name: 'generate_lead', relativeMs: 1_100 }),
        observation({ id: 'success', platform: 'browser', name: 'user_confirmed_success', relativeMs: 1_500 }),
        observation({ id: 'failure', platform: 'browser', name: 'user_confirmed_failure', relativeMs: 20_000 }),
      ],
      successfulActionObserved: true,
      failedActionObserved: true,
    };
    expect(buildTrackingTestConclusion(run)).toMatchObject({ status: 'normal', successfulAction: 'recorded_once', failedAction: 'not_recorded' });
  });

  it('redacts sensitive event names and only marks short-window same-platform duplicates', () => {
    const sanitized = sanitizeTrackingObservation(observation({ name: 'submit_email', fields: { eventId: true, transactionId: false, value: false, currency: false, items: false, sensitiveField: false, targetId: 'G-ABC' } }));
    expect(sanitized.name).toBe('疑似敏感字段事件');
    expect(JSON.stringify(sanitized)).not.toContain('submit_email');

    const run: TrackingTestRun = {
      id: 'run', projectId: 'project', startedAt: '2026-08-01T00:00:00Z', endedAt: null, goal: 'purchase', status: 'running', stages: [], duplicateEvents: [], sensitiveFieldNames: [], limitations: [],
      observations: [observation({ id: 'a', relativeMs: 1000 }), observation({ id: 'b', relativeMs: 1800 }), observation({ id: 'c', platform: 'google_tag_manager', relativeMs: 1900 }), observation({ id: 'd', relativeMs: 6000 })],
      successfulActionObserved: true, failedActionObserved: true,
    };
    const final = finalizeTrackingRun(run);
    expect(final.duplicateEvents).toEqual(['google_analytics:purchase']);
    expect(final.stages.find((item) => item.id === 'action')?.status).toBe('normal');
  });

  it('keeps a safe event name while flagging sensitive payload fields', () => {
    const sanitized = sanitizeTrackingObservation(observation({
      name: 'form_error',
      fields: { eventId: false, transactionId: false, value: false, currency: false, items: false, sensitiveField: true },
    }));
    expect(sanitized.name).toBe('form_error');
    expect(sanitized.fields.sensitiveField).toBe(true);
  });

  it('rejects untrusted observation platforms and strips invalid target IDs', () => {
    expect(validateTrackingObservation({ ...observation(), platform: 'attacker' })).toBeNull();
    expect(validateTrackingObservation({ ...observation(), relativeMs: Number.NaN })).toBeNull();
    expect(validateTrackingObservation({ ...observation(), fields: { ...observation().fields, targetId: 'secret@example.com' } })?.fields.targetId).toBeUndefined();
  });

  it('normalizes tracking pages without dropping language directories', () => {
    expect(normalizeTrackingPage('https://example.com/en-us/landing/?gclid=abc&utm_source=google&plan=pro#hero')).toBe('https://example.com/en-us/landing?plan=pro');
    expect(normalizeTrackingPage('/fr/landing/?utm_campaign=x')).toBe('/fr/landing');
  });

  it('imports GA4 Chinese fields and reconciles three evidence layers', () => {
    const preview = parseCsvPreview('日期,页面,来源,媒介,会话数,互动会话数,用户数,事件名称,关键事件数,总收入,货币\n2026-08-01,/en/landing,google,cpc,80,60,70,generate_lead,8,1000,USD', 'analytics_performance', 'GA4.csv');
    const rows = normalizeCsvRows(preview, { kind: 'analytics_performance', projectId: 'p', datasetId: 'a', mapping: preview.mapping, brandTerms: [] }) as AnalyticsPerformanceRow[];
    expect(rows[0]).toMatchObject({ page: '/en/landing', sessions: 80, keyEvents: 8, revenue: 1000, currency: 'USD' });

    const ads: SemPerformanceRow[] = [{ id: 's', datasetId: 's', projectId: 'p', platform: 'google', date: '2026-08-01', campaign: 'Search', adGroup: '', keyword: '', searchTerm: '', matchType: '', landingPage: '/en/landing', impressions: 1000, clicks: 100, cost: 300, platformConversions: 20, conversionValue: 1200, branded: false }];
    const business: BusinessOutcomeRow[] = [{ id: 'b', datasetId: 'b', projectId: 'p', date: '2026-08-01', attributionKey: '', status: 'valid', validConversions: 4, revenue: 800, refunds: 100, grossProfit: 400 }];
    const report = reconcileTrackingData({ projectId: 'p', currency: 'USD', analytics: rows, ads, business });
    expect(report).toMatchObject({ clicks: 100, sessions: 80, analyticsKeyEvents: 8, platformConversions: 20, validConversions: 4 });
    expect(report.findings.map((item) => item.title)).toEqual(expect.arrayContaining([expect.stringContaining('广告平台转化高于'), expect.stringContaining('有效业务差距')]));
    expect(report.period).toMatchObject({ start: '2026-08-01', end: '2026-08-01' });
    expect(report.alignment.matchedLandingPages).toBe(1);

    const page = healthySnapshot({ htmlLang: 'en-US' });
    const noAds = { ...settings, targetLanguage: '', useGoogleAds: false, useMicrosoftAds: false };
    const staticSnapshot = buildOverseasStaticSnapshot(page, noAds, { scriptUrls: [], inlineScriptText: [], resourceUrls: [], dataLayerEntries: [], uetEntries: [], currentUrl: page.url, finalUrl: page.url });
    const diagnosis = buildOverseasSummary({ snapshot: page, staticSnapshot, settings: noAds, reconciliation: report });
    expect(diagnosis.issues.map((item) => item.id)).toEqual(expect.arrayContaining(report.findings.map((item) => item.id)));
    expect(new Set(diagnosis.issues.map((item) => item.id)).size).toBe(diagnosis.issues.length);

    const auditReport = buildAuditReport({ ...page, overseas: staticSnapshot }, 1);
    const recommendations = buildOverseasOptimizationRecommendations(auditReport, diagnosis);
    expect(recommendations.map((item) => item.rootCauseId)).toEqual(expect.arrayContaining(report.findings.map((item) => item.id)));
  });

  it('stops amount comparison on currency conflict and grades attribution evidence', () => {
    const analytics: AnalyticsPerformanceRow[] = [{ id: 'a', datasetId: 'a', projectId: 'p', date: '2026-08-01', page: '/en/landing?utm_source=google', source: 'google', medium: 'cpc', campaign: 'Unique', sessions: 5, engagedSessions: 4, users: 5, eventName: 'purchase', keyEvents: 2, revenue: 200, currency: 'EUR' }];
    const ads: SemPerformanceRow[] = [{ id: 's', datasetId: 's', projectId: 'p', platform: 'google', date: '2026-08-01', campaign: 'Unique', adGroup: '', keyword: '', searchTerm: '', matchType: '', landingPage: '/en/landing?gclid=x', impressions: 100, clicks: 10, cost: 30, platformConversions: 2, conversionValue: 200, branded: false, clickId: 'click-exists', utmCampaign: 'Unique' }];
    const business: BusinessOutcomeRow[] = [
      { id: 'b1', datasetId: 'b', projectId: 'p', date: '2026-08-01', attributionKey: '', status: 'valid', validConversions: 1, revenue: 100, refunds: 0, grossProfit: 50, clickId: 'click-exists' },
      { id: 'b2', datasetId: 'b', projectId: 'p', date: '2026-08-01', attributionKey: '', status: 'valid', validConversions: 1, revenue: 100, refunds: 0, grossProfit: 50, utmCampaign: 'Unique' },
      { id: 'b3', datasetId: 'b', projectId: 'p', date: '2026-08-01', attributionKey: '', status: 'valid', validConversions: 1, revenue: 100, refunds: 0, grossProfit: 50 },
    ];
    const report = reconcileTrackingData({ projectId: 'p', currency: 'USD', timezone: 'America/New_York', analytics, ads, business });
    expect(report.currencyComparable).toBe(false);
    expect(report.observedCurrencies).toEqual(['USD', 'EUR']);
    expect(report.alignment).toMatchObject({ matchedLandingPages: 1, highConfidenceRows: 1, mediumConfidenceRows: 1, lowConfidenceRows: 1 });
    expect(report.gaps).toEqual(expect.arrayContaining([expect.stringContaining('金额不做跨来源比较')]));
  });

  it('blocks sensitive GA4 CSV columns', () => {
    const preview = parseCsvPreview('Date,Page,Event name,Key events,Email\n2026-08-01,/,lead,1,user@example.com', 'analytics_performance', 'ga4.csv');
    expect(preview.blockedHeaders).toContain('Email');
  });
});
