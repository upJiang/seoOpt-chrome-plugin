import Papa from 'papaparse';

import type { ServerLogSummary } from '../projects/types';

interface LogRequest {
  url: string;
  status: number;
  at: string | null;
  durationMs: number | null;
  botFamily: string | null;
}

const CSV_ALIASES: Record<string, string[]> = {
  url: ['url', 'request url', 'path', 'uri', '请求地址', '路径'],
  status: ['status', 'status code', 'http status', '状态码', '状态'],
  date: ['date', 'time', 'timestamp', '时间', '日期'],
  responseTime: ['response time', 'request time', 'duration', 'latency', '响应时间', '耗时'],
  userAgent: ['user agent', 'ua', 'user-agent', '客户端'],
};

function headerKey(value: string): string {
  return value.replace(/^\ufeff/, '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function valueFor(row: Record<string, string>, target: string): string {
  const aliases = (CSV_ALIASES[target] || []).map(headerKey);
  const source = Object.keys(row).find((key) => aliases.includes(headerKey(key)));
  return source ? String(row[source] ?? '').trim() : '';
}

function normalizeUrl(value: string): string {
  try {
    const parsed = new URL(value, 'https://log.invalid');
    parsed.hash = '';
    return `${parsed.pathname}${parsed.search}` || '/';
  } catch {
    return value.split('#')[0] || '/';
  }
}

function parseDuration(value: string): number | null {
  if (!value) return null;
  const numeric = Number(value.replace(',', '.').replace(/ms$/i, '').trim());
  if (!Number.isFinite(numeric)) return null;
  return /s$/i.test(value.trim()) && !/ms$/i.test(value.trim()) ? numeric * 1_000 : numeric;
}

function botFamily(userAgent: string): string | null {
  if (!userAgent) return null;
  if (/googlebot|storebot|adsbot-google/i.test(userAgent)) return 'Google';
  if (/bingbot|adidxbot/i.test(userAgent)) return 'Bing';
  if (/baiduspider/i.test(userAgent)) return 'Baidu';
  if (/yandex/i.test(userAgent)) return 'Yandex';
  if (/bot|spider|crawler|slurp/i.test(userAgent)) return '其他疑似爬虫';
  return null;
}

function parseDate(value: string): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value.replace(/\//g, '-'));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function parseNginxCombinedLine(line: string): LogRequest | null {
  const match = line.match(/^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([^\"]*)"\s+(\d{3})\s+(\S+)(?:\s+"([^\"]*)"\s+"([^\"]*)")?(?:\s+(.*))?$/);
  if (!match) return null;
  const request = match[3] || '';
  const requestUrl = request.match(/^\S+\s+(\S+)/)?.[1] || '/';
  const extras = match[8] || '';
  const durationMatch = extras.match(/(?:request_time|upstream_response_time|duration)[= ]([\d.]+)/i);
  return {
    url: normalizeUrl(requestUrl),
    status: Number(match[4]),
    at: parseDate(match[2] || ''),
    durationMs: durationMatch ? parseDuration(durationMatch[1] || '') : null,
    botFamily: botFamily(match[7] || ''),
  };
}

export function parseServerLogCsv(content: string): LogRequest[] {
  const parsed = Papa.parse<Record<string, string>>(content.replace(/^\ufeff/, ''), { header: true, skipEmptyLines: 'greedy' });
  return parsed.data.flatMap((row) => {
    const rawUrl = valueFor(row, 'url');
    if (!rawUrl) return [];
    const status = Number(valueFor(row, 'status'));
    return [{
      url: normalizeUrl(rawUrl),
      status: Number.isFinite(status) ? status : 0,
      at: parseDate(valueFor(row, 'date')),
      durationMs: parseDuration(valueFor(row, 'responseTime')),
      botFamily: botFamily(valueFor(row, 'userAgent')),
    }];
  });
}

function percentile(values: number[], percentileValue: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1));
  return sorted[index] ?? null;
}

export function aggregateServerLogs(input: { projectId: string; requests: LogRequest[]; sitemapUrls?: string[] }): ServerLogSummary {
  const requests = input.requests.filter((item) => item.url);
  const statusCounts: Record<string, number> = {};
  const botCounts = new Map<string, number>();
  const byUrl = new Map<string, LogRequest[]>();
  for (const request of requests) {
    const status = String(request.status || 0);
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    if (request.botFamily) botCounts.set(request.botFamily, (botCounts.get(request.botFamily) || 0) + 1);
    byUrl.set(request.url, [...(byUrl.get(request.url) || []), request]);
  }
  const slowUrlCandidates = [...byUrl.entries()].map(([url, values]) => {
    const durations = values.map((value) => value.durationMs).filter((value): value is number => value !== null);
    const averageMs = durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null;
    const p95Ms = percentile(durations, 0.95);
    return { url, requests: values.length, averageMs, p95Ms };
  }).filter((item) => (item.p95Ms ?? 0) >= 1_000 || (item.averageMs ?? 0) >= 800).sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0)).slice(0, 50);
  const wastedUrlCandidates = [...byUrl.entries()].flatMap(([url, values]) => {
    const reasons: string[] = [];
    if (/[?&](?:utm_|gclid|msclkid|bd_vid|sort|filter|page)=/i.test(url) && values.length >= 2) reasons.push('参数 URL 重复访问候选');
    if (values.some((value) => value.status >= 400)) reasons.push('错误状态 URL');
    return reasons.map((reason) => ({ url, reason, requests: values.length }));
  }).slice(0, 100);
  const dates = requests.map((request) => request.at).filter((value): value is string => Boolean(value)).sort();
  const seenUrls = new Set(requests.filter((request) => request.botFamily).map((request) => request.url));
  const sitemapNeverCrawledCandidates = (input.sitemapUrls || []).map(normalizeUrl).filter((url) => !seenUrls.has(url)).slice(0, 100);
  return {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    importedAt: new Date().toISOString(),
    requestCount: requests.length,
    dateMin: dates[0] || null,
    dateMax: dates.at(-1) || null,
    botFamilies: [...botCounts.entries()].sort((a, b) => b[1] - a[1]).map(([family, count]) => ({ family, requests: count, verified: false as const })),
    statusCounts,
    slowUrlCandidates,
    wastedUrlCandidates,
    sitemapNeverCrawledCandidates,
    privacy: 'aggregated_only',
  };
}

export function parseServerLog(input: { projectId: string; content: string; format?: 'nginx' | 'csv'; sitemapUrls?: string[] }): ServerLogSummary {
  const format = input.format || (input.content.split('\n').some((line) => line.includes(' HTTP/') && line.includes('[')) ? 'nginx' : 'csv');
  const requests = format === 'nginx'
    ? input.content.split(/\r?\n/).flatMap((line) => { const parsed = parseNginxCombinedLine(line); return parsed ? [parsed] : []; })
    : parseServerLogCsv(input.content);
  return aggregateServerLogs({ projectId: input.projectId, requests, ...(input.sitemapUrls ? { sitemapUrls: input.sitemapUrls } : {}) });
}
