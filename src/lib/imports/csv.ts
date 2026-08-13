import Papa from 'papaparse';

import type {
  AnalyticsPerformanceRow,
  BusinessOutcomeRow,
  ColumnMapping,
  DatasetKind,
  ImportDataset,
  SearchPlatform,
  SemCreativeRow,
  SemPerformanceRow,
  SeoPerformanceRow,
} from '../projects/types';

export const MAX_CSV_BYTES = 20 * 1024 * 1024;
export const MAX_CSV_ROWS = 100_000;

const SENSITIVE_COLUMN = /(?:e-?mail|邮箱|mailbox|phone|mobile|telephone|手机号|电话|姓名|customer\s*name|full\s*name|contact\s*name|^name$|地址|address|身份证|id.?card)/i;

const ALIASES: Record<string, string[]> = {
  platform: ['platform', '平台', '搜索引擎'],
  date: ['date', 'day', '日期', '时间'],
  query: ['query', 'top queries', '查询', '搜索查询', '关键词'],
  page: ['page', 'landing page', 'pages', '页面', '网页', '着陆页'],
  impressions: ['impressions', 'impr.', 'impr', '展示', '展示次数'],
  clicks: ['clicks', '点击', '点击次数'],
  ctr: ['ctr', 'click through rate', '点击率'],
  position: ['position', 'average position', '平均排名', '排名'],
  campaign: ['campaign', 'campaign name', '广告系列', '计划', '推广计划'],
  adGroup: ['ad group', 'ad group name', '广告组', '单元', '推广单元'],
  keyword: ['keyword', '关键词'],
  searchTerm: ['search term', 'search terms', '搜索词', '用户搜索词'],
  matchType: ['match type', 'keyword match type', '匹配类型', '匹配模式'],
  landingPage: ['landing page', 'final url', 'final urls', '最终网址', '访问网址', '落地页'],
  cost: ['cost', 'spend', '费用', '消费', '花费'],
  platformConversions: ['conversions', 'all conv.', '转化', '转化次数', '平台转化'],
  conversionValue: ['conversion value', 'conv. value', '转化价值', '转化金额'],
  conversionAction: ['conversion action', 'conversion action name', '转化操作', '转化动作'],
  conversionType: ['conversion type', 'goal category', 'primary conversion', '转化类型', '主要转化'],
  campaignType: ['campaign type', 'campaign subtype', '系列类型', '计划类型'],
  bidStrategy: ['bid strategy', 'bid strategy type', '出价策略'],
  budget: ['budget', 'campaign budget', 'daily budget', '预算', '日预算'],
  device: ['device', 'device type', '设备'],
  location: ['location', 'region', 'country', '地域', '地区'],
  hour: ['hour', 'hour of day', '时段', '小时'],
  clickId: ['click id', 'gclid', 'msclkid', 'bd_vid', '点击id', '点击标识'],
  utmCampaign: ['utm campaign', 'utm_campaign', 'utm系列', 'utm计划'],
  assetGroup: ['asset group', 'asset group name', '素材组', '资产组'],
  finalUrlExpansion: ['final url expansion', 'url expansion', '最终网址扩展'],
  headline: ['headline', 'headline 1', 'ad title', '标题', '创意标题'],
  description: ['description', 'description 1', '广告描述', '创意描述', '描述'],
  attributionKey: ['attribution key', 'click id', '订单号', '线索id', '归因键'],
  status: ['status', 'lead status', 'order status', '状态', '线索状态', '订单状态'],
  validConversions: ['valid conversions', 'qualified leads', '有效转化', '有效线索', '有效订单'],
  revenue: ['revenue', 'sales', '收入', '销售额'],
  refunds: ['refunds', 'refund', '退款', '退款金额'],
  grossProfit: ['gross profit', 'profit', '毛利', '利润'],
  conversionDelayDays: ['conversion delay days', 'days to conversion', '转化延迟天数', '成交天数'],
  source: ['source', 'source / medium', '来源', '来源平台'],
  medium: ['medium', '来源媒介', '媒介'],
  sessions: ['sessions', 'session', '会话', '会话数'],
  engagedSessions: ['engaged sessions', 'engaged session', '互动会话', '互动会话数'],
  users: ['users', 'total users', 'active users', '用户', '用户数'],
  eventName: ['event name', 'event', '事件名称', '事件'],
  keyEvents: ['key events', 'conversions', '关键事件', '关键事件数', '转化次数'],
  analyticsRevenue: ['purchase revenue', 'total revenue', 'revenue', '收入', '总收入'],
  currency: ['currency', '币种', '货币'],
};

const REQUIRED: Record<DatasetKind, string[]> = {
  seo_performance: ['query', 'page', 'impressions', 'clicks'],
  sem_performance: ['date', 'campaign', 'clicks', 'cost', 'platformConversions'],
  sem_creative: ['adGroup', 'headline', 'description', 'landingPage'],
  business_outcome: ['date', 'validConversions'],
  analytics_performance: ['date', 'page', 'eventName', 'keyEvents'],
};

const OPTIONAL: Record<DatasetKind, string[]> = {
  seo_performance: ['platform', 'date', 'ctr', 'position'],
  sem_performance: ['platform', 'adGroup', 'keyword', 'searchTerm', 'matchType', 'landingPage', 'impressions', 'conversionValue', 'conversionAction', 'conversionType', 'campaignType', 'bidStrategy', 'budget', 'device', 'location', 'hour', 'clickId', 'utmCampaign', 'assetGroup', 'finalUrlExpansion'],
  sem_creative: ['platform', 'campaign'],
  business_outcome: ['attributionKey', 'status', 'revenue', 'refunds', 'grossProfit', 'clickId', 'utmCampaign', 'conversionDelayDays'],
  analytics_performance: ['platform', 'source', 'medium', 'campaign', 'sessions', 'engagedSessions', 'users', 'analyticsRevenue', 'currency'],
};

function normalizedHeader(value: string): string {
  return value.replace(/^\ufeff/, '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

export function isSensitiveColumn(header: string): boolean {
  return SENSITIVE_COLUMN.test(normalizedHeader(header));
}

export function inferPlatform(headers: string[], filename = ''): SearchPlatform {
  const corpus = `${headers.join(' ')} ${filename}`.toLocaleLowerCase();
  if (/google|谷歌|gclid|search console/.test(corpus)) return 'google';
  if (/bing|microsoft|微软|msclkid/.test(corpus)) return 'bing';
  if (/baidu|百度/.test(corpus)) return 'baidu';
  return 'unknown';
}

export function suggestColumnMapping(headers: string[], kind: DatasetKind): ColumnMapping[] {
  const safeHeaders = headers.filter((header) => !isSensitiveColumn(header));
  return [...REQUIRED[kind], ...OPTIONAL[kind]].map((target) => {
    const aliases = new Set((ALIASES[target] ?? []).map(normalizedHeader));
    const source = safeHeaders.find((header) => aliases.has(normalizedHeader(header))) ?? '';
    return { source, target, confirmed: Boolean(source) };
  });
}

export interface CsvPreview {
  headers: string[];
  rows: Record<string, string>[];
  mapping: ColumnMapping[];
  missingRequired: string[];
  blockedHeaders: string[];
  platform: SearchPlatform;
  errors: string[];
}

export function parseCsvPreview(content: string, kind: DatasetKind, filename = ''): CsvPreview {
  if (new Blob([content]).size > MAX_CSV_BYTES) throw new Error('CSV 超过 20MB，请按日期或账户拆分后再导入。');
  const parsed = Papa.parse<Record<string, string>>(content.replace(/^\ufeff/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
  });
  const rowCount = parsed.data.length;
  if (rowCount > MAX_CSV_ROWS) throw new Error('CSV 超过 100,000 行，请拆分后再导入。');
  const headers = parsed.meta.fields ?? [];
  const blockedHeaders = headers.filter(isSensitiveColumn);
  const mapping = suggestColumnMapping(headers, kind);
  const missingRequired = REQUIRED[kind].filter((field) => !mapping.some((item) => item.target === field && item.source));
  return {
    headers,
    rows: parsed.data,
    mapping,
    missingRequired,
    blockedHeaders,
    platform: inferPlatform(headers, filename),
    errors: parsed.errors.slice(0, 10).map((error) => `第 ${error.row ?? '?'} 行：${error.message}`),
  };
}

function valueFor(row: Record<string, string>, mapping: ColumnMapping[], target: string): string {
  const source = mapping.find((item) => item.target === target)?.source;
  return source ? String(row[source] ?? '').trim() : '';
}

function numberValue(value: string, percent = false): number {
  if (!value) return 0;
  const negative = /^\(.*\)$/.test(value.trim());
  const normalized = value.replace(/[,%￥¥$€£\s]/g, '').replace(/[()]/g, '');
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return 0;
  const output = negative ? -parsed : parsed;
  return percent || value.includes('%') ? output / 100 : output;
}

function dateValue(value: string): string {
  if (!value) return '';
  const normalized = value.replace(/[年/.]/g, '-').replace(/月/g, '-').replace(/日/g, '');
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : value;
}

function includesBrand(value: string, terms: string[]): boolean {
  const normalized = value.toLocaleLowerCase();
  return terms.some((term) => term.trim() && normalized.includes(term.trim().toLocaleLowerCase()));
}

function platformValue(raw: string, fallback: SearchPlatform): SearchPlatform {
  return inferPlatform([raw]) === 'unknown' ? fallback : inferPlatform([raw]);
}

function conversionTypeValue(value: string): NonNullable<SemPerformanceRow['conversionType']> {
  if (/primary|主要|是|yes|true/i.test(value)) return 'primary';
  if (/observation|secondary|观察|次要|否|no|false/i.test(value)) return 'observation';
  return 'unknown';
}

export function normalizeCsvRows(
  preview: CsvPreview,
  options: { kind: DatasetKind; projectId: string; datasetId: string; mapping: ColumnMapping[]; brandTerms: string[] },
): Array<SeoPerformanceRow | SemPerformanceRow | SemCreativeRow | BusinessOutcomeRow | AnalyticsPerformanceRow> {
  for (const required of REQUIRED[options.kind]) {
    const mapped = options.mapping.find((item) => item.target === required)?.source;
    if (!mapped) throw new Error(`必填字段“${required}”尚未映射。`);
    if (isSensitiveColumn(mapped)) throw new Error(`敏感列“${mapped}”不能导入。`);
  }
  for (const item of options.mapping) {
    if (item.source && isSensitiveColumn(item.source)) throw new Error(`敏感列“${item.source}”不能映射。`);
  }

  const normalized = preview.rows.map((row) => {
    const common = {
      id: crypto.randomUUID(),
      datasetId: options.datasetId,
      projectId: options.projectId,
    };
    const platform = platformValue(valueFor(row, options.mapping, 'platform'), preview.platform);
    if (options.kind === 'seo_performance') {
      const impressions = numberValue(valueFor(row, options.mapping, 'impressions'));
      const clicks = numberValue(valueFor(row, options.mapping, 'clicks'));
      const query = valueFor(row, options.mapping, 'query');
      return {
        ...common,
        platform,
        date: dateValue(valueFor(row, options.mapping, 'date')),
        query,
        page: valueFor(row, options.mapping, 'page'),
        impressions,
        clicks,
        ctr: valueFor(row, options.mapping, 'ctr') ? numberValue(valueFor(row, options.mapping, 'ctr'), true) : (impressions ? clicks / impressions : 0),
        position: valueFor(row, options.mapping, 'position') ? numberValue(valueFor(row, options.mapping, 'position')) : null,
        branded: includesBrand(query, options.brandTerms),
      } satisfies SeoPerformanceRow;
    }
    if (options.kind === 'sem_performance') {
      const searchTerm = valueFor(row, options.mapping, 'searchTerm');
      const keyword = valueFor(row, options.mapping, 'keyword');
      return {
        ...common,
        platform,
        date: dateValue(valueFor(row, options.mapping, 'date')),
        campaign: valueFor(row, options.mapping, 'campaign'),
        adGroup: valueFor(row, options.mapping, 'adGroup'),
        keyword,
        searchTerm,
        matchType: valueFor(row, options.mapping, 'matchType'),
        landingPage: valueFor(row, options.mapping, 'landingPage'),
        impressions: numberValue(valueFor(row, options.mapping, 'impressions')),
        clicks: numberValue(valueFor(row, options.mapping, 'clicks')),
        cost: numberValue(valueFor(row, options.mapping, 'cost')),
        platformConversions: numberValue(valueFor(row, options.mapping, 'platformConversions')),
        conversionValue: numberValue(valueFor(row, options.mapping, 'conversionValue')),
        branded: includesBrand(searchTerm || keyword, options.brandTerms),
        ...(valueFor(row, options.mapping, 'conversionAction') ? { conversionAction: valueFor(row, options.mapping, 'conversionAction') } : {}),
        ...(valueFor(row, options.mapping, 'conversionType') ? { conversionType: conversionTypeValue(valueFor(row, options.mapping, 'conversionType')) } : {}),
        ...(valueFor(row, options.mapping, 'campaignType') ? { campaignType: valueFor(row, options.mapping, 'campaignType') } : {}),
        ...(valueFor(row, options.mapping, 'bidStrategy') ? { bidStrategy: valueFor(row, options.mapping, 'bidStrategy') } : {}),
        ...(valueFor(row, options.mapping, 'budget') ? { budget: numberValue(valueFor(row, options.mapping, 'budget')) } : {}),
        ...(valueFor(row, options.mapping, 'device') ? { device: valueFor(row, options.mapping, 'device') } : {}),
        ...(valueFor(row, options.mapping, 'location') ? { location: valueFor(row, options.mapping, 'location') } : {}),
        ...(valueFor(row, options.mapping, 'hour') ? { hour: valueFor(row, options.mapping, 'hour') } : {}),
        ...(valueFor(row, options.mapping, 'clickId') ? { clickId: valueFor(row, options.mapping, 'clickId') } : {}),
        ...(valueFor(row, options.mapping, 'utmCampaign') ? { utmCampaign: valueFor(row, options.mapping, 'utmCampaign') } : {}),
        ...(valueFor(row, options.mapping, 'assetGroup') ? { assetGroup: valueFor(row, options.mapping, 'assetGroup') } : {}),
        ...(valueFor(row, options.mapping, 'finalUrlExpansion') ? { finalUrlExpansion: valueFor(row, options.mapping, 'finalUrlExpansion') } : {}),
      } satisfies SemPerformanceRow;
    }
    if (options.kind === 'sem_creative') {
      return {
        ...common,
        platform,
        campaign: valueFor(row, options.mapping, 'campaign'),
        adGroup: valueFor(row, options.mapping, 'adGroup'),
        headline: valueFor(row, options.mapping, 'headline'),
        description: valueFor(row, options.mapping, 'description'),
        finalUrl: valueFor(row, options.mapping, 'landingPage'),
      } satisfies SemCreativeRow;
    }
    if (options.kind === 'analytics_performance') {
      return {
        ...common,
        date: dateValue(valueFor(row, options.mapping, 'date')),
        page: valueFor(row, options.mapping, 'page'),
        source: valueFor(row, options.mapping, 'source'),
        medium: valueFor(row, options.mapping, 'medium'),
        campaign: valueFor(row, options.mapping, 'campaign'),
        sessions: numberValue(valueFor(row, options.mapping, 'sessions')),
        engagedSessions: numberValue(valueFor(row, options.mapping, 'engagedSessions')),
        users: numberValue(valueFor(row, options.mapping, 'users')),
        eventName: valueFor(row, options.mapping, 'eventName'),
        keyEvents: numberValue(valueFor(row, options.mapping, 'keyEvents')),
        revenue: numberValue(valueFor(row, options.mapping, 'analyticsRevenue')),
        ...(valueFor(row, options.mapping, 'currency') ? { currency: valueFor(row, options.mapping, 'currency').toUpperCase() } : {}),
      } satisfies AnalyticsPerformanceRow;
    }
    return {
      ...common,
      date: dateValue(valueFor(row, options.mapping, 'date')),
      attributionKey: valueFor(row, options.mapping, 'attributionKey'),
      status: valueFor(row, options.mapping, 'status'),
      validConversions: numberValue(valueFor(row, options.mapping, 'validConversions')),
      revenue: numberValue(valueFor(row, options.mapping, 'revenue')),
      refunds: numberValue(valueFor(row, options.mapping, 'refunds')),
      grossProfit: numberValue(valueFor(row, options.mapping, 'grossProfit')),
      ...(valueFor(row, options.mapping, 'clickId') ? { clickId: valueFor(row, options.mapping, 'clickId') } : {}),
      ...(valueFor(row, options.mapping, 'utmCampaign') ? { utmCampaign: valueFor(row, options.mapping, 'utmCampaign') } : {}),
      ...(valueFor(row, options.mapping, 'conversionDelayDays') ? { conversionDelayDays: numberValue(valueFor(row, options.mapping, 'conversionDelayDays')) } : {}),
    } satisfies BusinessOutcomeRow;
  });
  if (options.kind !== 'business_outcome') return normalized;
  const seen = new Set<string>();
  return normalized.filter((row) => {
    const business = row as BusinessOutcomeRow;
    if (!business.attributionKey) return true;
    const key = `${business.date}\u0000${business.attributionKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function datasetFingerprint(content: string, kind: DatasetKind): string {
  let hash = 2166136261;
  const sample = `${kind}\u0000${content.length}\u0000${content.slice(0, 100_000)}`;
  for (let index = 0; index < sample.length; index += 1) {
    hash ^= sample.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildDataset(input: {
  id: string;
  projectId: string;
  kind: DatasetKind;
  platform: SearchPlatform;
  name: string;
  mapping: ColumnMapping[];
  rows: Array<SeoPerformanceRow | SemPerformanceRow | SemCreativeRow | BusinessOutcomeRow | AnalyticsPerformanceRow>;
  fingerprint: string;
}): ImportDataset {
  const dates = input.rows.map((row) => 'date' in row ? row.date : '').filter(Boolean).sort();
  return {
    id: input.id,
    projectId: input.projectId,
    kind: input.kind,
    platform: input.platform,
    name: input.name,
    rowCount: input.rows.length,
    mapping: input.mapping,
    dateMin: dates[0] ?? null,
    dateMax: dates.at(-1) ?? null,
    importedAt: new Date().toISOString(),
    fingerprint: input.fingerprint,
  };
}
