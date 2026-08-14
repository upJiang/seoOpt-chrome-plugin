import { describe, expect, it } from 'vitest';

import { normalizeCsvRows, parseCsvPreview } from '../src/lib/imports/csv';
import { compareEqualPeriods, diagnoseSem, linkBusinessOutcomes } from '../src/lib/sem/diagnostics';
import type { BusinessOutcomeRow, SearchProject, SemCreativeRow, SemPerformanceRow } from '../src/lib/projects/types';

const project: SearchProject = {
  id: 'p1',
  name: 'Example',
  origin: 'https://example.com',
  market: '中国',
  timezone: 'Asia/Shanghai',
  currency: 'CNY',
  brandTerms: ['Example'],
  primaryConversion: '有效表单',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  sem: { businessType: 'lead_generation', negativeTerms: [], landingTargetQuery: '', adPromise: '', targetCpa: null, targetRoas: null, grossProfitPerConversion: null },
};

describe('CSV imports', () => {
  it('parses quoted Chinese headers and blocks sensitive columns', () => {
    const preview = parseCsvPreview('\ufeff日期,推广计划,点击次数,消费,转化次数,搜索词,手机号\n2026-08-01,"品牌, 搜索",10,100,2,Example SEO,13800000000', 'sem_performance', '百度.csv');
    expect(preview.platform).toBe('baidu');
    expect(preview.rows[0]?.['推广计划']).toBe('品牌, 搜索');
    expect(preview.blockedHeaders).toEqual(['手机号']);
    expect(preview.missingRequired).toEqual([]);
  });

  it('normalizes SEO metrics and derives CTR', () => {
    const preview = parseCsvPreview('Query,Page,Impressions,Clicks,Position\nseo audit,https://example.com/a,100,5,8.2', 'seo_performance', 'gsc.csv');
    const rows = normalizeCsvRows(preview, { kind: 'seo_performance', projectId: 'p1', datasetId: 'd1', mapping: preview.mapping, brandTerms: [] });
    expect(rows[0]).toMatchObject({ impressions: 100, clicks: 5, ctr: 0.05, position: 8.2 });
  });

  it('deduplicates business events by date and attribution key', () => {
    const preview = parseCsvPreview('日期,有效转化,订单号,收入\n2026-08-01,1,order-1,100\n2026-08-01,1,order-1,100', 'business_outcome', 'orders.csv');
    const rows = normalizeCsvRows(preview, { kind: 'business_outcome', projectId: 'p1', datasetId: 'd1', mapping: preview.mapping, brandTerms: [] });
    expect(rows).toHaveLength(1);
  });

  it('normalizes click IDs, UTM attribution, primary conversions and platform automation fields', () => {
    const preview = parseCsvPreview('Date,Campaign,Clicks,Cost,Conversions,Primary Conversion,GCLID,utm_campaign,Campaign Type,Bid Strategy,Asset Group,Final URL Expansion\n2026-08-01,Core,20,200,4,Yes,click-1,core,PMax,Maximize Conversions,SEO Leads,Enabled', 'sem_performance', 'google-ads.csv');
    const rows = normalizeCsvRows(preview, { kind: 'sem_performance', projectId: 'p1', datasetId: 'd1', mapping: preview.mapping, brandTerms: [] }) as SemPerformanceRow[];
    expect(rows[0]).toMatchObject({ clickId: 'click-1', utmCampaign: 'core', conversionType: 'primary', campaignType: 'PMax', bidStrategy: 'Maximize Conversions', assetGroup: 'SEO Leads', finalUrlExpansion: 'Enabled' });
  });
});

describe('SEM diagnosis boundaries', () => {
  it('does not recommend scaling without business boundaries', () => {
    const rows: SemPerformanceRow[] = [{
      id: 'r1', datasetId: 'd1', projectId: 'p1', platform: 'google', date: '2026-08-01', campaign: 'Search', adGroup: 'Core', keyword: 'seo', searchTerm: 'seo', matchType: 'broad', landingPage: 'https://example.com', impressions: 1000, clicks: 50, cost: 500, platformConversions: 5, conversionValue: 2000, branded: false,
    }];
    const result = diagnoseSem(project, rows, []);
    expect(result.dataGaps.some((gap) => gap.includes('扩量'))).toBe(true);
    expect(result.findings.every((item) => !/提高.*预算|扩量/.test(item.action))).toBe(true);
    expect(result.statuses.conversionQuality).toBe('insufficient');
    expect(result.metrics.find((item) => item.id === 'refund-roas')).toMatchObject({ value: null, state: 'insufficient' });
    expect(result.metrics.find((item) => item.id === 'platform-value-roas')?.value).toBe(4);
  });

  it('keeps diagnosis usable when project currency is still unknown', () => {
    const unknownCurrencyProject = { ...project, currency: 'unknown' };
    const rows: SemPerformanceRow[] = [{
      id: 'unknown-currency', datasetId: 'd1', projectId: 'p1', platform: 'google', date: '2026-08-01', campaign: 'Search', adGroup: 'Core', keyword: 'seo', searchTerm: 'seo', matchType: 'exact', landingPage: 'https://example.com', impressions: 100, clicks: 10, cost: 120, platformConversions: 2, conversionValue: 300, branded: false,
    }];
    const result = diagnoseSem(unknownCurrencyProject, rows, []);
    expect(result.metrics.find((item) => item.id === 'cpc')?.formattedValue).toBe('12（币种未设置）');
    expect(result.dataGaps.some((item) => item.includes('币种尚未设置'))).toBe(true);
  });

  it('compares the latest period with the previous equal-length period', () => {
    const rows: SemPerformanceRow[] = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'].map((date, index) => ({
      id: `r${index}`, datasetId: 'd1', projectId: 'p1', platform: 'google', date, campaign: 'Search', adGroup: 'Core', keyword: 'seo', searchTerm: 'seo', matchType: 'broad', landingPage: 'https://example.com', impressions: 100, clicks: 10, cost: 100, platformConversions: 1, conversionValue: 200, branded: false,
    }));
    const comparison = compareEqualPeriods(rows);
    expect(comparison.previous.map((row) => row.date)).toEqual(['2026-08-02', '2026-08-03']);
    expect(comparison.current.map((row) => row.date)).toEqual(['2026-08-04', '2026-08-05']);
  });

  it('uses creative completeness and real business outcomes in the report', () => {
    const performance: SemPerformanceRow[] = [{
      id: 'r1', datasetId: 'd1', projectId: 'p1', platform: 'google', date: '2026-08-01', campaign: 'Search', adGroup: 'Core', keyword: 'seo', searchTerm: 'seo', matchType: 'exact', landingPage: 'https://example.com', impressions: 1000, clicks: 100, cost: 500, platformConversions: 10, conversionValue: 3000, branded: false,
    }];
    const business: BusinessOutcomeRow[] = [{ id: 'b1', datasetId: 'd2', projectId: 'p1', date: '2026-08-01', attributionKey: '', status: 'paid', validConversions: 5, revenue: 2000, refunds: 200, grossProfit: 900 }];
    const creatives: SemCreativeRow[] = [{ id: 'c1', datasetId: 'd3', projectId: 'p1', platform: 'google', campaign: 'Search', adGroup: 'Core', headline: '', description: '描述', finalUrl: 'https://example.com' }];
    const result = diagnoseSem(project, performance, business, creatives);
    expect(result.findings.some((item) => item.stage === 'creative_landing')).toBe(true);
    expect(result.metrics.find((item) => item.id === 'refund-roas')?.value).toBe(3.6);
    expect(result.metrics.find((item) => item.id === 'profit-return')?.value).toBe(1.8);
  });

  it('links business outcomes by click ID first, then unique UTM and campaign fallback', () => {
    const performance: SemPerformanceRow[] = [
      { id: 'click-row', datasetId: 'd', projectId: 'p1', platform: 'google', date: '2026-08-01', campaign: 'Core', adGroup: '', keyword: '', searchTerm: '', matchType: '', landingPage: '', impressions: 1, clicks: 1, cost: 1, platformConversions: 1, conversionValue: 0, branded: false, clickId: 'gclid-1', utmCampaign: 'core-utm' },
      { id: 'utm-row', datasetId: 'd', projectId: 'p1', platform: 'google', date: '2026-08-01', campaign: 'Other', adGroup: '', keyword: '', searchTerm: '', matchType: '', landingPage: '', impressions: 1, clicks: 1, cost: 1, platformConversions: 1, conversionValue: 0, branded: false, utmCampaign: 'other-utm' },
    ];
    const business: BusinessOutcomeRow[] = [
      { id: 'b1', datasetId: 'b', projectId: 'p1', date: '2026-08-01', attributionKey: '', status: 'paid', validConversions: 1, revenue: 10, refunds: 0, grossProfit: 5, clickId: 'gclid-1' },
      { id: 'b2', datasetId: 'b', projectId: 'p1', date: '2026-08-01', attributionKey: '', status: 'paid', validConversions: 1, revenue: 10, refunds: 0, grossProfit: 5, utmCampaign: 'other-utm' },
      { id: 'b3', datasetId: 'b', projectId: 'p1', date: '2026-08-01', attributionKey: 'Core', status: 'paid', validConversions: 1, revenue: 10, refunds: 0, grossProfit: 5 },
    ];
    const result = linkBusinessOutcomes(performance, business);
    expect(result.linked).toBe(3);
    expect(business.map((row) => row.attributionConfidence)).toEqual(['high', 'medium', 'low']);
    expect(result.byPerformanceRow.get('click-row')).toHaveLength(2);
  });

  it('keeps PMax, AI Max and Baidu oCPC conclusions inside available evidence', () => {
    const rows: SemPerformanceRow[] = [
      { id: 'pmax', datasetId: 'd', projectId: 'p1', platform: 'google', date: '2026-08-01', campaign: 'PMax', adGroup: '', keyword: '', searchTerm: '', matchType: '', landingPage: 'https://example.com/p', impressions: 100, clicks: 10, cost: 100, platformConversions: 2, conversionValue: 200, branded: false, campaignType: 'PMax' },
      { id: 'aimax', datasetId: 'd', projectId: 'p1', platform: 'google', date: '2026-08-02', campaign: 'AI', adGroup: '', keyword: '', searchTerm: '', matchType: '', landingPage: 'https://example.com/a', impressions: 100, clicks: 10, cost: 100, platformConversions: 2, conversionValue: 200, branded: false, campaignType: 'AI Max' },
      { id: 'ocpc', datasetId: 'd', projectId: 'p1', platform: 'baidu', date: '2026-08-03', campaign: 'Baidu', adGroup: '', keyword: '', searchTerm: '', matchType: '', landingPage: 'https://example.com/b', impressions: 100, clicks: 10, cost: 100, platformConversions: 2, conversionValue: 200, branded: false, bidStrategy: 'oCPC' },
    ];
    const report = diagnoseSem(project, rows, []);
    expect(report.dataGaps).toEqual(expect.arrayContaining([
      expect.stringContaining('PMax'),
      expect.stringContaining('AI Max'),
    ]));
    expect(report.findings.some((item) => item.title.includes('百度 oCPC') && item.action.includes('先核对'))).toBe(true);
    expect(report.findings.every((item) => !/自动.*预算|自动.*否定词/.test(item.action))).toBe(true);
  });

  it('protects the learning period and flags overlapping core changes', () => {
    const rows: SemPerformanceRow[] = [{ id: 'r', datasetId: 'd', projectId: 'p1', platform: 'google', date: '2026-08-01', campaign: 'Core', adGroup: '', keyword: '', searchTerm: 'seo', matchType: 'exact', landingPage: 'https://example.com', impressions: 1000, clicks: 100, cost: 500, platformConversions: 10, conversionValue: 1000, branded: false, conversionType: 'primary' }];
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const report = diagnoseSem(project, rows, [], [], [
      { id: 'c1', projectId: 'p1', type: 'status_change', channel: 'sem', semDimension: 'budget', createdAt: new Date().toISOString(), learningUntil: future, summary: '提高预算' },
      { id: 'c2', projectId: 'p1', type: 'status_change', channel: 'sem', semDimension: 'landing_page', createdAt: new Date().toISOString(), learningUntil: future, summary: '更换落地页' },
    ]);
    const finding = report.findings.find((item) => item.title.includes('重叠观察期'));
    expect(finding).toMatchObject({ priority: 'P2', confidence: 'high' });
    expect(finding?.action).toContain('暂停叠加新的核心变量');
  });
});
