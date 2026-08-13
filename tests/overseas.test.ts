import { describe, expect, it } from 'vitest';

import { normalizeCsvRows, parseCsvPreview } from '../src/lib/imports/csv';
import {
  buildOverseasStaticSnapshot,
  diagnoseOverseasStatic,
  finalizeTrackingRun,
  normalizeTrackingPage,
  reconcileTrackingData,
  sanitizeTrackingObservation,
  validateTrackingObservation,
} from '../src/lib/overseas/diagnostics';
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
      expect.objectContaining({ title: expect.stringContaining('UET'), priority: 'P0' }),
      expect.objectContaining({ title: expect.stringContaining('丢失') }),
    ]));
  });
});

describe('tracking privacy and reconciliation', () => {
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
