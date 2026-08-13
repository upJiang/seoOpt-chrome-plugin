import { XMLParser } from 'fast-xml-parser';
import { parseHTML } from 'linkedom';

import { parseRobotsPolicy } from '../audit/robots';
import type { ParsedRobotsPolicy } from '../audit/robots';
import { assessCache, assessCompression, collectResponseHeaders } from '../audit/technical';
import type { EvidenceConfidence, InternalLinkOpportunity, SiteAuditIssue, SiteAuditRun, SiteInventorySummary, SitePageRecord } from '../projects/types';
import { classifyUrlTemplate, validateJsonLd } from '../seo/semantic';
import { siteIssueGuidanceForCode } from './guidance';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const CONCURRENCY = 4;
const MAX_SITEMAP_CHILDREN = 10;

export interface SiteAuditOptions {
  projectId: string;
  origin: string;
  currentUrl?: string;
  limit: 20 | 50 | 100;
  resumeRun?: SiteAuditRun;
  existingPages?: SitePageRecord[];
  signal?: AbortSignal;
  onBatch?: (run: SiteAuditRun, pages: SitePageRecord[]) => Promise<void> | void;
  entryVariants?: SiteAuditRun['entryVariants'];
}

interface RobotsState {
  url: string;
  text: string;
  sitemaps: string[];
  status: number | null;
  policy: ParsedRobotsPolicy | null;
}

interface SitemapState {
  urls: Set<string>;
  roots: string[];
  discovered: boolean;
  status: number | null;
  childCount: number;
  invalidUrls: number;
  invalidLastmod: number;
  compressedFiles: number;
}

function sameOriginUrl(value: string, origin: string): string | null {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !/^https?:$/.test(url.protocol)) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

async function fetchLimited(url: string, signal?: AbortSignal): Promise<{ response: Response; text: string; bytes: Uint8Array }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.5' },
    });
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_BODY_BYTES) throw new Error('响应正文超过 2MB 上限');
    const reader = response.body?.getReader();
    if (!reader) {
      const bytes = new Uint8Array((await response.arrayBuffer()).slice(0, MAX_BODY_BYTES));
      return { response, text: new TextDecoder().decode(bytes), bytes };
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('响应正文超过 2MB 上限');
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { response, text: new TextDecoder().decode(bytes), bytes };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function arrayValue<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function valueText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function validSitemapDate(value: string): boolean {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function sitemapEntries(xml: string): { urls: string[]; children: string[]; valid: boolean; invalidLastmod: number } {
  try {
    const parsed = new XMLParser({ ignoreAttributes: false, trimValues: true, removeNSPrefix: true }).parse(xml) as {
      urlset?: { url?: Array<{ loc?: string }> | { loc?: string } };
      sitemapindex?: { sitemap?: Array<{ loc?: string }> | { loc?: string } };
    };
    const pageEntries = arrayValue(parsed.urlset?.url);
    const childEntries = arrayValue(parsed.sitemapindex?.sitemap);
    const urls = pageEntries.map((item) => valueText(item.loc)).filter(Boolean);
    const children = childEntries.map((item) => valueText(item.loc)).filter(Boolean);
    const invalidLastmod = [...pageEntries, ...childEntries]
      .filter((item) => item && typeof item === 'object' && !validSitemapDate(valueText((item as { lastmod?: unknown }).lastmod))).length;
    return { urls, children, valid: Boolean(parsed.urlset || parsed.sitemapindex), invalidLastmod };
  } catch {
    return { urls: [], children: [], valid: false, invalidLastmod: 0 };
  }
}

async function decodeSitemapBody(text: string, bytes: Uint8Array, response: Response, url: string): Promise<{ text: string; compressed: boolean }> {
  const compressed = /\.gz(?:$|\?)/i.test(url) || /(?:application|text)\/(?:x-)?gzip/i.test(response.headers.get('content-type') || '');
  if (!compressed || !globalThis.DecompressionStream) return { text, compressed };
  try {
    const raw = new Uint8Array(bytes).buffer;
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
    return { text: await new Response(stream).text(), compressed: true };
  } catch {
    // Browsers often transparently decompress HTTP content-encoding. If the body
    // already looks like XML, keep it instead of treating a valid sitemap as bad.
    return { text, compressed };
  }
}

async function readRobots(origin: string, signal?: AbortSignal): Promise<RobotsState> {
  const url = `${origin}/robots.txt`;
  try {
    const { response, text } = await fetchLimited(url, signal);
    if (!response.ok) return { url, text: '', sitemaps: [], status: response.status, policy: response.status === 404 ? parseRobotsPolicy(url, '', origin) : null };
    const policy = parseRobotsPolicy(url, text, origin);
    return { url, text, sitemaps: policy.sitemaps, status: response.status, policy };
  } catch {
    return { url, text: '', sitemaps: [], status: null, policy: null };
  }
}

async function readSitemaps(origin: string, robots: RobotsState, signal?: AbortSignal): Promise<SitemapState> {
  const sitemapState: SitemapState = {
    urls: new Set(),
    roots: [],
    discovered: false,
    status: null,
    childCount: 0,
    invalidUrls: 0,
    invalidLastmod: 0,
    compressedFiles: 0,
  };
  const candidates = (robots.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`])
    .map((url) => sameOriginUrl(url, origin))
    .filter((url): url is string => Boolean(url));
  sitemapState.roots = [...new Set(candidates)];
  const queue = [...sitemapState.roots];
  const visited = new Set<string>();
  while (queue.length && visited.size < MAX_SITEMAP_CHILDREN + sitemapState.roots.length) {
    const sitemapUrl = queue.shift()!;
    if (visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);
    try {
      const { response, text, bytes } = await fetchLimited(sitemapUrl, signal);
      if (sitemapState.status === null) sitemapState.status = response.status;
      if (!response.ok) continue;
      const decoded = await decodeSitemapBody(text, bytes, response, sitemapUrl);
      if (decoded.compressed) sitemapState.compressedFiles += 1;
      const parsed = sitemapEntries(decoded.text);
      if (!parsed.valid) {
        sitemapState.invalidUrls += 1;
        continue;
      }
      sitemapState.discovered = true;
      sitemapState.invalidLastmod += parsed.invalidLastmod;
      for (const value of parsed.urls) {
        const normalized = sameOriginUrl(value, origin);
        if (normalized) sitemapState.urls.add(normalized);
        else sitemapState.invalidUrls += 1;
      }
      for (const value of parsed.children) {
        const normalized = sameOriginUrl(value, origin);
        if (!normalized) {
          sitemapState.invalidUrls += 1;
          continue;
        }
        if (sitemapState.childCount >= MAX_SITEMAP_CHILDREN || visited.has(normalized)) continue;
        sitemapState.childCount += 1;
        queue.push(normalized);
      }
    } catch {
      // A broken child must not prevent the remaining sample from being inspected.
    }
  }
  return sitemapState;
}

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function simhash(value: string): string {
  const normalized = normalizeText(value).toLocaleLowerCase();
  const latin = normalized.match(/[a-z\d][a-z\d-]{1,30}/g) || [];
  const hanRuns = normalized.match(/[\p{Script=Han}]{2,}/gu) || [];
  const tokens = [...latin, ...hanRuns.flatMap((run) => Array.from({ length: Math.max(1, run.length - 1) }, (_, index) => run.length === 2 ? run : run.slice(index, index + 2)))];
  if (!tokens.length) return '';
  const weights = new Map<string, number>();
  for (const token of tokens) weights.set(token, (weights.get(token) || 0) + 1);
  const vector = Array.from({ length: 32 }, () => 0);
  for (const [token, weight] of weights) {
    const hash = Number.parseInt(fingerprint(token), 16) >>> 0;
    for (let bit = 0; bit < 32; bit += 1) vector[bit] = (vector[bit] ?? 0) + (((hash >>> bit) & 1) === 1 ? weight : -weight);
  }
  let hash = 0;
  for (let bit = 0; bit < 32; bit += 1) if (vector[bit]! >= 0) hash = (hash | (1 << bit)) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

function simhashDistance(left: string, right: string): number {
  let bits = (Number.parseInt(left, 16) ^ Number.parseInt(right, 16)) >>> 0;
  let distance = 0;
  while (bits) {
    bits = (bits & (bits - 1)) >>> 0;
    distance += 1;
  }
  return distance;
}

function nearDuplicateUrlGroups(pages: SitePageRecord[]): string[][] {
  const candidates = pages.filter((page) => page.nearDuplicateFingerprint);
  const visited = new Set<string>();
  const groups: string[][] = [];
  for (const page of candidates) {
    if (visited.has(page.url)) continue;
    const group = candidates.filter((candidate) => simhashDistance(page.nearDuplicateFingerprint!, candidate.nearDuplicateFingerprint!) <= 5);
    if (group.length < 2) continue;
    group.forEach((candidate) => visited.add(candidate.url));
    groups.push(group.map((candidate) => candidate.url));
  }
  return groups;
}

function noindex(values: string[]): boolean {
  return values.some((value) => /(?:^|[,\s])(?:noindex|none)(?:$|[,\s])/i.test(value));
}

function titlePattern(value: string): string {
  return normalizeText(value).toLocaleLowerCase().replace(/\d+/g, ':n').replace(/[^\p{L}\p{N}:]+/gu, ' ').trim();
}

function topicTerms(value: string): string[] {
  const normalized = normalizeText(value).toLocaleLowerCase();
  const latin = normalized.match(/[a-z\d][a-z\d-]{1,30}/g) || [];
  const chineseRuns = normalized.match(/[\p{Script=Han}]{2,}/gu) || [];
  const chinese = chineseRuns.flatMap((run) => run.length <= 4 ? [run] : Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2)));
  const stop = new Set(['this', 'that', 'with', 'from', 'your', 'www', 'http', 'https', '页面', '网站', '内容', '以及', '一个', '我们', '可以']);
  const counts = new Map<string, number>();
  for (const term of [...latin, ...chinese]) if (!stop.has(term)) counts.set(term, (counts.get(term) || 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 24).map(([term]) => term);
}

async function probeCanonical(url: string, origin: string, canonical: string, signal?: AbortSignal): Promise<{ resolved: string | null; status: number | null; indexable: boolean | null }> {
  const resolved = sameOriginUrl(canonical, origin);
  if (!resolved) return { resolved: null, status: null, indexable: null };
  if (resolved === url) return { resolved, status: null, indexable: null };
  try {
    const { response, text } = await fetchLimited(resolved, signal);
    let indexable: boolean | null = null;
    if (/html|xhtml/i.test(response.headers.get('content-type') || '') || /<html[\s>]/i.test(text.slice(0, 500))) {
      const { document } = parseHTML(text);
      const directives = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="robots" i],meta[name="googlebot" i]')).map((item) => item.content);
      indexable = !noindex(directives) && response.status >= 200 && response.status < 300;
    }
    return { resolved, status: response.status, indexable };
  } catch {
    return { resolved, status: null, indexable: null };
  }
}

async function inspectPage(input: {
  url: string;
  runId: string;
  projectId: string;
  origin: string;
  robots: RobotsState;
  sitemapUrls: Set<string>;
  signal?: AbortSignal;
}): Promise<SitePageRecord> {
  const allowedByRobots = input.robots.text
    ? parseRobotsPolicy(input.robots.url, input.robots.text, input.url).allowed
    : true;
  const template = classifyUrlTemplate(input.url);
  const base: SitePageRecord = {
    id: `${input.runId}:${fingerprint(input.url)}`,
    runId: input.runId,
    projectId: input.projectId,
    url: input.url,
    finalUrl: input.url,
    status: null,
    contentType: '',
    title: '',
    description: '',
    robots: [],
    canonical: '',
    h1: [],
    textLength: 0,
    contentFingerprint: '',
    internalLinks: [],
    hreflangs: [],
    inSitemap: input.sitemapUrls.has(input.url),
    allowedByRobots,
    redirectCount: 0,
    error: null,
    fetchedAt: new Date().toISOString(),
    pageType: template.type,
    templateKey: template.key,
    isSearchPage: template.type === 'search',
    isTagPage: template.type === 'tag',
    isFilterPage: template.type === 'filter',
    isPaginationPage: template.type === 'pagination',
    paginationNumber: template.type === 'pagination' ? Number(new URL(input.url).searchParams.get('page') || input.url.match(/(?:page|p)[-_]?(\d+)/i)?.[1] || 2) : null,
    nofollowInternalCount: 0,
    nofollowExternalCount: 0,
    pageNofollow: false,
    crawlerAccessStatus: allowedByRobots ? 'unavailable' : 'attention',
    robotsBlockedResourceCount: 0,
  };
  if (!allowedByRobots) return base;
  try {
    const { response, text } = await fetchLimited(input.url, input.signal);
    const finalUrl = sameOriginUrl(response.url || input.url, input.origin) || response.url || input.url;
    const contentType = response.headers.get('content-type') || '';
    const responseHeaders = collectResponseHeaders(response.headers);
    const responseBytes = new TextEncoder().encode(text).byteLength;
    const compression = assessCompression(contentType, responseHeaders, responseBytes);
    const cache = assessCache(finalUrl, contentType, responseHeaders);
    const record = {
      ...base,
      status: response.status,
      finalUrl,
      contentType,
      redirectCount: finalUrl === input.url ? 0 : 1,
      responseHeaders,
      compressionStatus: compression.status,
      compressionExplanation: compression.explanation,
      cacheStatus: cache.status,
      cacheExplanation: cache.explanation,
      crawlerAccessStatus: response.status >= 400 ? 'attention' as const : 'good' as const,
    };
    if (!/html|xhtml/i.test(contentType) && !/<html[\s>]/i.test(text.slice(0, 500))) return record;
    const { document } = parseHTML(text);
    const pageTitle = normalizeText(document.querySelector('title')?.textContent);
    const authorPresent = Boolean(document.querySelector('[rel="author"],[itemprop="author"],.author,[class*="author"]'));
    const datePresent = Boolean(document.querySelector('time[datetime],[itemprop="datePublished"],[itemprop="dateModified"]'));
    const schemaElements = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json" i]'));
    const schemas = schemaElements.map((element) => {
      try {
        return validateJsonLd(JSON.parse(element.textContent || ''), { title: pageTitle, authorPresent, datePresent });
      } catch {
        return { validSyntax: false, types: [], pageType: 'unknown' as const, issues: [{ code: 'invalid-json', severity: 'error' as const, message: 'JSON-LD 语法错误' }], visibleMismatchFields: [] };
      }
    });
    const resourceUrls = Array.from(document.querySelectorAll<HTMLElement>('script[src],link[rel~="stylesheet"][href],img[src]'))
      .flatMap((element) => {
        const value = element.getAttribute('src') || element.getAttribute('href') || '';
        const normalized = sameOriginUrl(value, input.origin);
        return normalized ? [normalized] : [];
      });
    const pagePolicy = input.robots.text
      ? parseRobotsPolicy(input.robots.url, input.robots.text, input.url, 'Googlebot', resourceUrls)
      : null;
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
    const internalNofollow = anchors.filter((anchor) => {
      const target = sameOriginUrl(anchor.getAttribute('href') || '', input.origin);
      return Boolean(target && /(?:^|\s)nofollow(?:\s|$)/i.test(anchor.getAttribute('rel') || ''));
    }).length;
    const externalNofollow = anchors.filter((anchor) => {
      const href = anchor.getAttribute('href') || '';
      let external = false;
      try { external = new URL(href, input.origin).origin !== input.origin; } catch { return false; }
      return external && /(?:^|\s)nofollow(?:\s|$)/i.test(anchor.getAttribute('rel') || '');
    }).length;
    document.querySelectorAll('script,style,noscript,template').forEach((element) => element.remove());
    const bodyText = normalizeText(document.body?.textContent);
    const internalLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
      .map((anchor) => sameOriginUrl(anchor.getAttribute('href') || '', input.origin))
      .filter((url): url is string => Boolean(url));
    const directives = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="robots" i],meta[name="googlebot" i]')).map((item) => normalizeText(item.content));
    const canonical = document.querySelector<HTMLLinkElement>('link[rel~="canonical"]')?.getAttribute('href') || '';
    const canonicalProbe = await probeCanonical(input.url, input.origin, canonical, input.signal);
    return {
      ...record,
      title: pageTitle,
      description: normalizeText(document.querySelector<HTMLMetaElement>('meta[name="description" i]')?.content),
      robots: directives,
      canonical,
      ...(canonicalProbe.resolved ? { canonicalResolved: canonicalProbe.resolved } : {}),
      canonicalStatus: canonicalProbe.status,
      canonicalIndexable: canonicalProbe.indexable,
      h1: Array.from(document.querySelectorAll('h1')).map((item) => normalizeText(item.textContent)).filter(Boolean),
      textLength: bodyText.length,
      contentFingerprint: bodyText.length >= 80 ? fingerprint(bodyText.replace(/\d+/g, '#').slice(0, 50_000)) : '',
      bodyFingerprint: bodyText.length >= 20 ? fingerprint(bodyText.toLocaleLowerCase().slice(0, 240).replace(/\d+/g, '#')) : '',
      nearDuplicateFingerprint: bodyText.length >= 80 ? simhash(bodyText.slice(0, 20_000).replace(/\d+/g, '#')) : '',
      internalLinks: [...new Set(internalLinks)],
      hreflangs: Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="alternate"][hreflang]')).map((item) => ({ lang: item.hreflang, href: item.href })),
      jsonLdTypes: [...new Set(schemas.flatMap((schema) => schema.types))],
      jsonLdIssues: schemas.flatMap((schema) => schema.issues.map((item) => item.message)),
      titlePattern: titlePattern(document.querySelector('title')?.textContent || ''),
      contentTerms: topicTerms(`${document.querySelector('title')?.textContent || ''} ${Array.from(document.querySelectorAll('h1,h2')).map((item) => item.textContent || '').join(' ')} ${bodyText.slice(0, 8_000)}`),
      nofollowInternalCount: internalNofollow,
      nofollowExternalCount: externalNofollow,
      pageNofollow: directives.some((value) => /(?:^|[,;\s])(?:nofollow|none)(?:$|[,;\s])/i.test(value)),
      robotsBlockedResourceCount: pagePolicy?.blockedResources.length || 0,
      crawlerAccessStatus: response.status >= 400
        ? 'attention'
        : (pagePolicy?.blockedResources.length || 0) > 0 || bodyText.length < 80
          ? 'confirm'
          : 'good',
      ...(document.documentElement.getAttribute('lang') ? { language: document.documentElement.getAttribute('lang')! } : {}),
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : '请求失败' };
  }
}

function issue(code: string, title: string, priority: SiteAuditIssue['priority'], confidence: EvidenceConfidence, evidence: string, urls: string[], sampled = false): SiteAuditIssue {
  return { id: `${code}:${crypto.randomUUID()}`, code, title, priority, confidence, evidence, ...siteIssueGuidanceForCode(code), affectedUrls: urls.slice(0, 100), sampled };
}

function firstPageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('page');
    parsed.pathname = parsed.pathname.replace(/(?:\/page|\/p)[-_]?\d+\/?$/i, '/')
      .replace(/(?:page|p)[-_]?\d+(?:\.html)?\/?$/i, '/');
    parsed.hash = '';
    return parsed.href;
  } catch { return url; }
}

function textGroups(pages: SitePageRecord[], field: 'title' | 'description' | 'contentFingerprint'): string[][] {
  const groups = new Map<string, string[]>();
  for (const page of pages) {
    const value = page[field];
    if (!value) continue;
    const urls = groups.get(value) ?? [];
    urls.push(page.url);
    groups.set(value, urls);
  }
  return [...groups.values()].filter((urls) => urls.length > 1);
}

function buildTemplateClusters(pages: SitePageRecord[]): SiteInventorySummary['templateClusters'] {
  const grouped = new Map<string, SitePageRecord[]>();
  for (const page of pages) {
    const key = page.templateKey || 'other:unknown';
    grouped.set(key, [...(grouped.get(key) || []), page]);
  }
  return [...grouped.entries()].map(([key, clusterPages]) => ({
    key,
    label: key.split(':')[0] || 'other',
    pageType: clusterPages[0]?.pageType || 'other',
    sampledUrls: clusterPages.slice(0, 10).map((page) => page.url),
    totalSampled: clusterPages.length,
    statusCounts: Object.fromEntries([...new Set(clusterPages.map((page) => String(page.status)))].map((status) => [status, clusterPages.filter((page) => String(page.status) === status).length])),
    duplicateTitleCount: textGroups(clusterPages, 'title').reduce((sum, group) => sum + group.length, 0),
    duplicateContentCount: textGroups(clusterPages, 'contentFingerprint').reduce((sum, group) => sum + group.length, 0),
    noindexCount: clusterPages.filter((page) => noindex(page.robots)).length,
    sitemapCount: clusterPages.filter((page) => page.inSitemap).length,
  }));
}

function populateLinkSignals(pages: SitePageRecord[], origin: string): void {
  const incoming = new Map<string, number>();
  const graph = new Map<string, string[]>();
  for (const page of pages) {
    const links = page.internalLinks.filter((link) => pages.some((candidate) => candidate.url === link));
    graph.set(page.url, links);
    for (const link of links) incoming.set(link, (incoming.get(link) || 0) + 1);
    page.outboundLinkCount = page.internalLinks.length;
    page.incomingLinkCount = incoming.get(page.url) || 0;
  }
  const root = `${origin}/`;
  const distances = new Map<string, number>([[root, 0]]);
  const queue = [root];
  while (queue.length) {
    const current = queue.shift()!;
    for (const target of graph.get(current) || []) {
      if (distances.has(target)) continue;
      distances.set(target, (distances.get(current) || 0) + 1);
      queue.push(target);
    }
  }
  for (const page of pages) {
    page.incomingLinkCount = incoming.get(page.url) || 0;
    page.linkDepth = distances.get(page.url) ?? null;
  }
}

function hreflangProblemPages(pages: SitePageRecord[]): string[] {
  const byUrl = new Map(pages.map((page) => [page.url, page]));
  const problems: string[] = [];
  for (const page of pages) {
    const links = page.hreflangs || [];
    const own = page.language ? links.some((link) => link.lang.toLocaleLowerCase() === page.language!.toLocaleLowerCase() && sameOriginUrl(link.href, new URL(page.url).origin) === page.url) : true;
    if (page.language && links.length && !own) problems.push(page.url);
    for (const link of links) {
      const target = sameOriginUrl(link.href, new URL(page.url).origin);
      if (!target) { problems.push(page.url); continue; }
      const targetPage = byUrl.get(target);
      if (targetPage && !targetPage.hreflangs.some((back) => sameOriginUrl(back.href, new URL(page.url).origin) === page.url)) problems.push(page.url);
      if (targetPage && (targetPage.status === null || targetPage.status >= 400 || noindex(targetPage.robots))) problems.push(page.url);
    }
  }
  return [...new Set(problems)];
}

export function buildInternalLinkOpportunities(pages: SitePageRecord[]): InternalLinkOpportunity[] {
  const documentFrequency = new Map<string, number>();
  for (const page of pages) for (const term of new Set(page.contentTerms || [])) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
  const candidateTargets = pages.filter((page) => page.status === 200 && !noindex(page.robots) && (page.incomingLinkCount || 0) <= 1);
  const opportunities: InternalLinkOpportunity[] = [];
  for (const target of candidateTargets) {
    const targetTerms = new Set(target.contentTerms || []);
    if (!targetTerms.size) continue;
    const candidates = pages
      .filter((source) => source.url !== target.url && source.status === 200 && !source.internalLinks.includes(target.url))
      .map((source) => {
        const shared = (source.contentTerms || []).filter((term) => targetTerms.has(term));
        const relevance = shared.reduce((sum, term) => sum + Math.log((pages.length + 1) / ((documentFrequency.get(term) || 0) + 0.5)), 0);
        return { source, shared, relevance };
      })
      .filter((item) => item.shared.length >= 1 && item.relevance > 0)
      .sort((left, right) => right.relevance - left.relevance);
    const best = candidates[0];
    if (!best) continue;
    opportunities.push({
      id: `link:${fingerprint(`${best.source.url}\u0000${target.url}`)}`,
      sourceUrl: best.source.url,
      targetUrl: target.url,
      suggestedAnchor: normalizeText(target.h1[0] || target.title || new URL(target.url).pathname).slice(0, 80),
      reason: `来源页与目标页共享主题词：${best.shared.slice(0, 4).join('、')}。目标页在本次样本中只有 ${target.incomingLinkCount || 0} 个入链。`,
      relevance: Number(best.relevance.toFixed(3)),
      confidence: pages.length >= 50 ? 'medium' : 'low',
    });
  }
  return opportunities.sort((left, right) => right.relevance - left.relevance).slice(0, 20);
}

export function buildSiteInventorySummary(pages: SitePageRecord[], sitemap: Pick<SitemapState, 'discovered' | 'status' | 'urls' | 'childCount' | 'invalidUrls' | 'invalidLastmod' | 'compressedFiles'>): SiteInventorySummary {
  const nearDuplicateGroups = nearDuplicateUrlGroups(pages).length;
  const counts = (type: SitePageRecord['pageType']) => pages.filter((page) => page.pageType === type).length;
  const confidence: EvidenceConfidence = pages.length >= 50 ? 'high' : pages.length >= 20 ? 'medium' : 'low';
  return {
    sampledPages: pages.length,
    sitemap: { discovered: sitemap.discovered, status: sitemap.status, urlCount: sitemap.urls.size, childCount: sitemap.childCount, invalidUrls: sitemap.invalidUrls, invalidLastmod: sitemap.invalidLastmod, compressedFiles: sitemap.compressedFiles },
    templateClusters: buildTemplateClusters(pages),
    queryUrlCount: pages.filter((page) => { try { return new URL(page.url).search.length > 0; } catch { return false; } }).length,
    searchUrlCount: counts('search'),
    tagUrlCount: counts('tag'),
    filterUrlCount: counts('filter'),
    paginationUrlCount: counts('pagination'),
    emptyContentCount: pages.filter((page) => page.status && page.status < 400 && page.textLength < 80).length,
    nearDuplicateGroups,
    orphanCandidates: pages.filter((page) => page.inSitemap && page.url !== `${new URL(page.url).origin}/` && page.incomingLinkCount === 0).length,
    hreflangIssues: hreflangProblemPages(pages).length,
    internalLinkOpportunities: buildInternalLinkOpportunities(pages),
    confidence,
  };
}

export function aggregateSiteIssues(
  pages: SitePageRecord[],
  sitemap?: Pick<SitemapState, 'discovered' | 'status' | 'urls' | 'childCount' | 'invalidUrls' | 'invalidLastmod' | 'compressedFiles'>,
  robots?: RobotsState,
  entryVariants: NonNullable<SiteAuditRun['entryVariants']> = [],
): SiteAuditIssue[] {
  const issues: SiteAuditIssue[] = [];
  const failed = pages.filter((page) => page.error || (page.status !== null && page.status >= 400));
  if (failed.length) issues.push(issue('site.response', '页面打不开或返回错误', 'P1', 'high', `${failed.length} 个采样 URL 无法正常交付。`, failed.map((page) => page.url)));
  if (robots?.policy?.syntaxIssues.length) issues.push(issue('site.robots-syntax', '抓取规则（robots.txt）存在格式风险', 'P2', 'high', `${robots.policy.syntaxIssues.length} 处格式可能无法按预期解析：${robots.policy.syntaxIssues.slice(0, 3).join('；')}。`, []));
  if (robots?.policy?.unknownDirectives.length) issues.push(issue('site.robots-directive', '抓取规则包含需要确认的非标准指令', 'P3', 'medium', `发现 ${robots.policy.unknownDirectives.join('、')}；不同搜索引擎可能忽略这些指令。`, []));
  const compressed = pages.filter((page) => page.compressionStatus === 'attention');
  if (compressed.length) issues.push(issue('site.compression', '部分文本页面没有启用传输压缩', 'P2', 'high', `${compressed.length} 个采样 HTML 响应超过 1KB，但没有发现 gzip 或 Brotli 响应头。`, compressed.map((page) => page.url), true));
  const cache = pages.filter((page) => page.cacheStatus === 'attention' || (page.cacheStatus === 'confirm' && !page.cacheExplanation?.startsWith('没有足够')));
  if (cache.length) issues.push(issue('site.cache', '部分页面或资源缓存策略需要调整', 'P2', 'medium', `${cache.length} 个采样响应有明确的缓存风险；应按 HTML、版本化静态资源和登录页分别处理。`, cache.map((page) => page.url), true));
  const internalNofollow = pages.filter((page) => (page.nofollowInternalCount || 0) > 0 || page.pageNofollow);
  if (internalNofollow.length) issues.push(issue('site.nofollow', '站内主要链接或页面级 nofollow 需要确认', 'P2', 'medium', `${internalNofollow.length} 个采样页面设置了页面级 nofollow 或站内 nofollow。`, internalNofollow.map((page) => page.url), true));
  const blockedResources = pages.filter((page) => (page.robotsBlockedResourceCount || 0) > 0);
  if (blockedResources.length) issues.push(issue('site.robots-resources', '抓取规则可能阻止页面渲染所需资源', 'P2', 'high', `${blockedResources.length} 个采样页面引用的 CSS、JavaScript 或图片被 robots.txt 阻止。`, blockedResources.map((page) => page.url), true));
  if (entryVariants.length) {
    const successful = entryVariants.filter((variant) => variant.status !== null && variant.status < 400 && variant.finalUrl);
    const finalOrigins = new Set(successful.flatMap((variant) => { try { return [new URL(variant.finalUrl).origin]; } catch { return []; } }));
    const downgrade = successful.some((variant) => { try { return new URL(variant.finalUrl).protocol !== 'https:'; } catch { return true; } });
    const chainRisk = entryVariants.some((variant) => variant.redirectCount > 3 || /循环|超过/.test(variant.error || ''));
    const failedEntries = entryVariants.filter((variant) => variant.status === null || variant.status >= 400 || variant.error);
    if (downgrade || chainRisk || finalOrigins.size > 1 || failedEntries.length) {
      const evidence = downgrade
        ? '至少一个已检查入口最终仍使用 HTTP。'
        : chainRisk
          ? '至少一个入口存在循环或超过 3 次的跳转链。'
          : finalOrigins.size > 1
            ? `可访问入口最终到达 ${finalOrigins.size} 个不同主机。`
            : `${failedEntries.length} 个入口请求失败或返回错误状态。`;
      issues.push(issue('site.entry', '网站访问入口没有稳定收敛', downgrade || chainRisk ? 'P1' : 'P2', 'high', evidence, entryVariants.map((variant) => variant.requestedUrl), false));
    }
  }
  if (sitemap && !sitemap.discovered) {
    const statusText = sitemap.status === null ? '请求失败或超时' : `返回 ${sitemap.status}`;
    issues.push(issue('site.sitemap-missing', '没有找到可用的页面清单（Sitemap）', 'P2', 'medium', `默认或 robots.txt 声明的 Sitemap ${statusText}，本次没有读取到有效 URL。`, []));
  }
  if (sitemap && sitemap.invalidUrls > 0) issues.push(issue('site.sitemap-invalid', '页面清单中有无效或跨域地址', 'P2', 'high', `Sitemap 中有 ${sitemap.invalidUrls} 个地址无法作为当前网站的有效 URL。`, []));
  if (sitemap && sitemap.invalidLastmod > 0) issues.push(issue('site.sitemap-lastmod', '页面清单中的更新时间格式无效', 'P2', 'high', `Sitemap 中有 ${sitemap.invalidLastmod} 个 lastmod 不是有效的 ISO 日期。`, []));
  const noindexInSitemap = pages.filter((page) => page.inSitemap && noindex(page.robots));
  if (noindexInSitemap.length) issues.push(issue('site.sitemap-noindex', '网站页面清单和“不收录”设置互相冲突', 'P1', 'high', `${noindexInSitemap.length} 个 Sitemap URL 声明 noindex。`, noindexInSitemap.map((page) => page.url)));
  const canonicalConflicts = pages.filter((page) => page.canonical && page.canonicalResolved !== page.url);
  if (canonicalConflicts.length) issues.push(issue('site.canonical', '页面声明的首选地址指向了其他页面', 'P2', 'medium', `${canonicalConflicts.length} 个页面需确认是否为有意合并。`, canonicalConflicts.map((page) => page.url), true));
  const canonicalUnavailable = pages.filter((page) => page.canonicalResolved && page.canonicalResolved !== page.url && ((page.canonicalStatus ?? null) === null || (page.canonicalStatus ?? 0) >= 400 || page.canonicalIndexable === false));
  if (canonicalUnavailable.length) issues.push(issue('site.canonical-target', '首选地址的目标页面不可正常收录', 'P1', 'high', `${canonicalUnavailable.length} 个页面的 Canonical 目标返回错误、不可测或声明 noindex。`, canonicalUnavailable.map((page) => page.url)));
  const paginationCanonical = pages.filter((page) => page.isPaginationPage && page.canonicalResolved && page.canonicalResolved === firstPageUrl(page.url));
  if (paginationCanonical.length) issues.push(issue('site.pagination-canonical', '分页页面都指向第一页的首选地址', 'P2', 'medium', `${paginationCanonical.length} 个分页 URL 把 Canonical 指向第一页；需确认分页是否有独立搜索价值。`, paginationCanonical.map((page) => page.url), true));
  const searchable = pages.filter((page) => page.isSearchPage && !noindex(page.robots));
  if (searchable.length) issues.push(issue('site.search-indexable', '站内搜索结果页可能被搜索引擎收录', 'P2', 'medium', `${searchable.length} 个可识别的搜索结果 URL 没有 noindex；这类页面常产生大量低价值组合。`, searchable.map((page) => page.url), true));
  const expansion = pages.filter((page) => page.isFilterPage || page.isTagPage || page.isSearchPage);
  if (expansion.length >= 3) issues.push(issue('site.url-expansion', '筛选、标签或搜索 URL 可能造成页面膨胀', 'P2', 'medium', `样本中发现 ${expansion.length} 个筛选/标签/搜索 URL。需要按页面任务决定允许收录、Canonical 或 noindex。`, expansion.map((page) => page.url), true));
  const empty = pages.filter((page) => page.status && page.status < 400 && page.textLength < 80 && !page.isSearchPage);
  if (empty.length) issues.push(issue('site.empty-content', '部分页面返回成功但主要正文几乎为空', 'P1', 'medium', `${empty.length} 个页面状态正常，但正文少于 80 个字符；可能是模板空状态或渲染失败。`, empty.map((page) => page.url), true));

  for (const [field, label] of [['title', '标题'], ['description', '描述'], ['contentFingerprint', '正文']] as const) {
    const duplicated = textGroups(pages, field).flat();
    if (duplicated.length) issues.push(issue(`site.duplicate-${field}`, `采样范围发现重复${label}候选`, 'P2', 'medium', `${duplicated.length} 个 URL 在本次样本中重复；需要结合页面任务人工确认。`, duplicated, true));
  }
  const near = nearDuplicateUrlGroups(pages).flat();
  if (near.length) issues.push(issue('site.near-duplicate', '发现正文开头高度相似的页面候选', 'P2', 'low', `${near.length} 个 URL 的正文开头相似，可能是同一模板或轻微改写页面；这是采样候选，不是自动判定重复。`, near, true));
  const templates = buildTemplateClusters(pages).filter((cluster) => cluster.totalSampled >= 2 && cluster.duplicateTitleCount >= 2);
  if (templates.length) issues.push(issue('site.template-overlap', '同一页面模板可能复用了不区分页面的内容', 'P2', 'medium', `${templates.length} 个模板样本出现重复标题或正文；优先检查模板变量和页面任务。`, templates.flatMap((cluster) => cluster.sampledUrls), true));
  const schemaProblems = pages.filter((page) => (page.jsonLdIssues || []).length > 0);
  if (schemaProblems.length) issues.push(issue('site.schema-semantic', '结构化数据字段与页面内容可能不一致', 'P2', 'medium', `${schemaProblems.length} 个页面的 JSON-LD 存在字段缺失、日期格式或可见内容冲突候选。`, schemaProblems.map((page) => page.url), true));
  const hreflang = hreflangProblemPages(pages);
  if (hreflang.length) issues.push(issue('site.hreflang-reciprocal', '多语言页面的 hreflang 互相声明不完整', 'P2', 'low', `${hreflang.length} 个页面的语言链接缺少自引用、互返或目标可收录证据。`, hreflang, true));
  populateLinkSignals(pages, pages[0] ? new URL(pages[0].url).origin : 'https://invalid.example');
  const sampleOrphans = pages.filter((page) => page.inSitemap && page.url !== `${new URL(page.url).origin}/` && page.incomingLinkCount === 0);
  if (sampleOrphans.length) issues.push(issue('site.orphan-candidate', '页面可能缺少其他站内页面的链接入口', 'P2', 'low', `${sampleOrphans.length} 个 Sitemap URL 未从本次采样内链发现，不代表全站一定孤立。`, sampleOrphans.map((page) => page.url), true));
  return issues;
}

function stratifiedSample(urls: string[], limit: number): string[] {
  const groups = new Map<string, string[]>();
  for (const url of urls) {
    const key = classifyUrlTemplate(url).key;
    groups.set(key, [...(groups.get(key) || []), url]);
  }
  const output: string[] = [];
  const queues = [...groups.values()];
  while (output.length < limit && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      const value = queue.shift();
      if (value) output.push(value);
      if (output.length >= limit) break;
    }
  }
  return output;
}

async function probeAuditOrigin(origin: string, signal?: AbortSignal): Promise<NonNullable<SiteAuditRun['entryVariants']>[number]> {
  const requestedUrl = `${origin}/`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(requestedUrl, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    await response.body?.cancel().catch(() => undefined);
    return {
      requestedUrl,
      finalUrl: response.url || requestedUrl,
      status: response.status,
      redirectCount: response.url && response.url !== requestedUrl ? 1 : 0,
      chain: [],
      chainComplete: false,
      error: null,
    };
  } catch (error) {
    return {
      requestedUrl,
      finalUrl: requestedUrl,
      status: null,
      redirectCount: 0,
      chain: [],
      chainComplete: false,
      error: error instanceof Error ? error.message : '网站入口请求失败',
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function runSiteAudit(options: SiteAuditOptions): Promise<{ run: SiteAuditRun; pages: SitePageRecord[] }> {
  const origin = new URL(options.origin).origin;
  const now = new Date().toISOString();
  const run: SiteAuditRun = options.resumeRun ? {
    ...options.resumeRun,
    status: 'running',
    limit: options.limit,
    updatedAt: now,
    error: null,
  } : {
    id: crypto.randomUUID(),
    projectId: options.projectId,
    origin,
    status: 'running',
    limit: options.limit,
    queuedUrls: [],
    completedUrls: [],
    blockedUrls: [],
    pages: 0,
    issues: [],
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    error: null,
  };
  await options.onBatch?.({ ...run }, []);
  const robots = await readRobots(origin, options.signal);
  const sitemap = await readSitemaps(origin, robots, options.signal);
  const seeds = [origin + '/', options.currentUrl || '', ...stratifiedSample([...sitemap.urls], Math.max(options.limit * 2, 40))]
    .map((url) => sameOriginUrl(url, origin)).filter((url): url is string => Boolean(url));
  const initial = [...new Set(seeds)];
  const queued = run.queuedUrls.length ? run.queuedUrls : stratifiedSample(initial, options.limit);
  const queue = queued.filter((url) => !run.completedUrls.includes(url)).slice(0, options.limit);
  const seen = new Set([...run.completedUrls, ...queue]);
  const pagesByUrl = new Map((options.existingPages ?? []).map((page) => [page.url, page]));

  try {
    while (queue.length && run.completedUrls.length < options.limit) {
      if (options.signal?.aborted) throw new DOMException('用户取消站点审计', 'AbortError');
      const batchUrls = queue.splice(0, CONCURRENCY);
      const batch = await Promise.all(batchUrls.map((url) => inspectPage({ url, runId: run.id, projectId: options.projectId, origin, robots, sitemapUrls: sitemap.urls, ...(options.signal ? { signal: options.signal } : {}) })));
      for (const page of batch) pagesByUrl.set(page.url, page);
      for (const page of batch) {
        run.completedUrls.push(page.url);
        if (page.allowedByRobots === false) run.blockedUrls.push(page.url);
        for (const link of page.internalLinks) {
          if (seen.size >= options.limit || seen.has(link)) continue;
          seen.add(link);
          queue.push(link);
        }
      }
      run.queuedUrls = [...queue];
      run.pages = run.completedUrls.length;
      run.updatedAt = new Date().toISOString();
      const currentPages = [...pagesByUrl.values()];
      run.inventory = buildSiteInventorySummary(currentPages, sitemap);
      await options.onBatch?.({ ...run }, batch);
    }
    const pages = [...pagesByUrl.values()];
    populateLinkSignals(pages, origin);
    run.status = 'completed';
    run.completedAt = new Date().toISOString();
    run.queuedUrls = [];
    run.pages = pages.length;
    run.inventory = buildSiteInventorySummary(pages, sitemap);
    if (!run.entryVariants?.length) {
      run.entryVariants = options.entryVariants?.length
        ? options.entryVariants
        : [await probeAuditOrigin(origin, options.signal)];
    }
    run.robotsSummary = {
      status: robots.status,
      agentAccess: robots.policy?.agentAccess || null,
      syntaxIssues: robots.policy?.syntaxIssues || [],
      unknownDirectives: robots.policy?.unknownDirectives || [],
    };
    run.issues = aggregateSiteIssues(pages, sitemap, robots, run.entryVariants);
  } catch (error) {
    const pages = [...pagesByUrl.values()];
    populateLinkSignals(pages, origin);
    run.status = error instanceof DOMException && error.name === 'AbortError' ? 'paused' : 'failed';
    run.error = error instanceof Error ? error.message : '站点审计失败';
    run.queuedUrls = [...queue];
    run.pages = pages.length;
    run.inventory = buildSiteInventorySummary(pages, sitemap);
    if (!run.entryVariants?.length) {
      run.entryVariants = options.entryVariants?.length
        ? options.entryVariants
        : [await probeAuditOrigin(origin)];
    }
    run.robotsSummary = {
      status: robots.status,
      agentAccess: robots.policy?.agentAccess || null,
      syntaxIssues: robots.policy?.syntaxIssues || [],
      unknownDirectives: robots.policy?.unknownDirectives || [],
    };
    run.issues = aggregateSiteIssues(pages, sitemap, robots, run.entryVariants);
  }
  run.updatedAt = new Date().toISOString();
  const finalPages = [...pagesByUrl.values()];
  await options.onBatch?.({ ...run }, []);
  return { run, pages: finalPages };
}
