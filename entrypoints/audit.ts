import type {
  AuditFinding,
  ElementLocator,
  HreflangSnapshot,
  ImageSnapshot,
  JsonLdSnapshot,
  LinkSnapshot,
  PageSnapshot,
  PerformanceSnapshot,
  RuntimeMessage,
  ResourceSnapshot,
  SitemapProbe,
  SiteProbeResult,
  TechnicalDeliveryProbe,
  VideoSnapshot,
} from '../src/lib/audit/types';
import { parseRobotsPolicy } from '../src/lib/audit/robots';
import { classifyUrlTemplate, normalizedAltRisk, validateJsonLd } from '../src/lib/seo/semantic';
import {
  assessCache,
  assessCompression,
  buildCrawlerAccess,
  buildSchemaSuggestions,
  collectResponseHeaders,
  EMPTY_RESPONSE_HEADERS,
  evaluateTransport,
  preferredSiteHost,
  summarizeLinkRels,
  summarizeResources,
} from '../src/lib/audit/technical';
import { buildOverseasStaticSnapshot } from '../src/lib/overseas/diagnostics';

interface SeoOptGlobal {
  __SEO_OPT_INSTALLED__?: boolean;
  __SEO_OPT_OVERLAY__?: OverlayState;
}

interface OverlayItem {
  finding: AuditFinding;
  element: Element;
  box: HTMLDivElement;
}

interface OverlayState {
  host: HTMLDivElement;
  items: OverlayItem[];
  abortController: AbortController;
  resizeObserver: ResizeObserver;
  mutationObserver: MutationObserver;
  frame: number | null;
}

let observedUrl = location.href;

function notifyPageStale(): void {
  void chrome.runtime.sendMessage({ type: 'PAGE_STALE', url: location.href } satisfies RuntimeMessage).catch(() => {
    // The extension may be reloading; stale state is also guarded by tab update events.
  });
}

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

function roots(): Array<Document | ShadowRoot> {
  const output: Array<Document | ShadowRoot> = [document];
  for (let index = 0; index < output.length; index += 1) {
    const root = output[index]!;
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) output.push(element.shadowRoot);
    }
  }
  return output;
}

function deepQueryAll<T extends Element>(selector: string): T[] {
  return roots().flatMap((root) => Array.from(root.querySelectorAll<T>(selector)));
}

function cssEscape(value: string): string {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

function selectorWithinRoot(element: Element, root: Document | ShadowRoot): string {
  if (element.id) {
    const idSelector = `#${cssEscape(element.id)}`;
    if (root.querySelectorAll(idSelector).length === 1) return idSelector;
  }

  const parts: string[] = [];
  let current: Element | null = element;
  while (current) {
    const tag = current.tagName.toLocaleLowerCase();
    const parent: Element | null = current.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = (Array.from(parent.children) as Element[]).filter(
      (child) => child.tagName === current!.tagName,
    );
    const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : '';
    parts.unshift(`${tag}${suffix}`);
    current = parent;
  }
  return parts.join(' > ');
}

function locatorFor(element: Element): ElementLocator {
  const segments: string[] = [];
  let current: Element = element;
  while (true) {
    const root = current.getRootNode();
    if (!(root instanceof Document || root instanceof ShadowRoot)) break;
    segments.unshift(selectorWithinRoot(current, root));
    if (root instanceof Document) break;
    current = root.host;
  }
  return { segments };
}

function resolveLocator(locator: ElementLocator): Element | null {
  let root: Document | ShadowRoot = document;
  let element: Element | null = null;
  for (let index = 0; index < locator.segments.length; index += 1) {
    const selector = locator.segments[index]!;
    try {
      element = root.querySelector(selector);
    } catch {
      return null;
    }
    if (!element) return null;
    if (index < locator.segments.length - 1) {
      if (!element.shadowRoot) return null;
      root = element.shadowRoot;
    }
  }
  return element;
}

function visibleText(value: string | null | undefined, limit = 320): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function accessibleName(anchor: HTMLAnchorElement): string {
  const imageAlt = Array.from(anchor.querySelectorAll('img'))
    .map((image) => image.getAttribute('alt') || '')
    .join(' ');
  return visibleText(anchor.getAttribute('aria-label') || anchor.innerText || imageAlt, 180);
}

function collectLinks(origin: string): LinkSnapshot[] {
  return deepQueryAll<HTMLAnchorElement>('a').map((anchor) => {
    const rawHref = anchor.getAttribute('href') ?? '';
    let parsed: URL | null = null;
    try {
      parsed = new URL(rawHref, location.href);
    } catch {
      parsed = null;
    }
    const isFragment = rawHref.trim().startsWith('#');
    let fragmentExists = true;
    if (isFragment && parsed?.hash) {
      const id = decodeURIComponent(parsed.hash.slice(1));
      fragmentExists = Boolean(document.getElementById(id) || document.getElementsByName(id).length > 0);
    }
    return {
      href: parsed?.href ?? rawHref,
      rawHref,
      text: visibleText(anchor.innerText, 180),
      accessibleName: accessibleName(anchor),
      isInternal: parsed?.origin === origin,
      isFragment,
      fragmentExists,
      rel: (anchor.getAttribute('rel') || '').toLocaleLowerCase().split(/\s+/).filter(Boolean),
      context: anchor.closest('nav,header') ? 'navigation' : anchor.closest('main,[role="main"]') ? 'main' : anchor.closest('footer') ? 'footer' : 'other',
      locator: locatorFor(anchor),
    };
  });
}

function collectImages(): ImageSnapshot[] {
  const images = deepQueryAll<HTMLImageElement>('img');
  const allAlts = images.map((image) => image.getAttribute('alt') || '').filter(Boolean);
  const pageTitle = document.title.trim();
  return images.map((image) => {
    const style = getComputedStyle(image);
    const rect = image.getBoundingClientRect();
    const widthAttribute = image.hasAttribute('width') ? Number(image.getAttribute('width')) : null;
    const heightAttribute = image.hasAttribute('height') ? Number(image.getAttribute('height')) : null;
    const stableRatio = style.aspectRatio && style.aspectRatio !== 'auto';
    return {
      src: image.currentSrc || image.src,
      alt: image.hasAttribute('alt') ? image.getAttribute('alt') : null,
      widthAttribute: Number.isFinite(widthAttribute) ? widthAttribute : null,
      heightAttribute: Number.isFinite(heightAttribute) ? heightAttribute : null,
      hasStableDimensions: Boolean(
        (widthAttribute && heightAttribute && widthAttribute > 0 && heightAttribute > 0) || stableRatio,
      ),
      loading: image.getAttribute('loading') || '',
      inInitialViewport: rect.top < innerHeight && rect.bottom > 0,
      renderedArea: Math.max(0, rect.width) * Math.max(0, rect.height),
      insideLink: Boolean(image.closest('a')),
      role: image.getAttribute('role'),
      locator: locatorFor(image),
      normalizedAlt: (image.getAttribute('alt') || '').trim(),
      altRisk: normalizedAltRisk(image.hasAttribute('alt') ? image.getAttribute('alt') : null, pageTitle, Boolean(image.closest('a')), allAlts),
      nearbyText: visibleText(image.closest('figure, picture, a')?.textContent, 180),
    };
  });
}

function collectVideos(): VideoSnapshot[] {
  return deepQueryAll<HTMLVideoElement>('video').map((video) => {
    const rect = video.getBoundingClientRect();
    const text = visibleText(video.textContent, 180);
    const nearby = visibleText(video.closest('figure')?.textContent, 180);
    return {
      poster: video.poster,
      preload: video.preload,
      hasTextFallback: Boolean(text || nearby),
      inInitialViewport: rect.top < innerHeight && rect.bottom > 0,
      locator: locatorFor(video),
    };
  });
}

function schemaTypes(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaTypes);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const current = Array.isArray(record['@type'])
    ? record['@type'].filter((type): type is string => typeof type === 'string')
    : typeof record['@type'] === 'string'
      ? [record['@type']]
      : [];
  return [...current, ...schemaTypes(record['@graph'])];
}

function collectJsonLd(): JsonLdSnapshot[] {
  const pageTitle = document.title.trim();
  const authorPresent = Boolean(deepQueryAll('[rel="author"],[itemprop="author"],.author,[class*="author"]').length);
  const datePresent = Boolean(deepQueryAll('time[datetime],[itemprop="datePublished"],[itemprop="dateModified"]').length);
  return deepQueryAll<HTMLScriptElement>('script[type="application/ld+json"]').map((script) => {
    const raw = script.textContent || '';
    try {
      const parsed: unknown = JSON.parse(raw);
      const schema = validateJsonLd(parsed, { title: pageTitle, authorPresent, datePresent });
      return {
        valid: true,
        types: schema.types,
        error: null,
        rawPreview: visibleText(raw, 240),
        locator: locatorFor(script),
        schema,
      };
    } catch (error) {
      return {
        valid: false,
        types: [],
        error: error instanceof Error ? error.message.slice(0, 180) : '无法解析 JSON',
        rawPreview: visibleText(raw, 240),
        locator: locatorFor(script),
      };
    }
  });
}

function collectHreflangs(): HreflangSnapshot[] {
  return deepQueryAll<HTMLLinkElement>('link[rel~="alternate"][hreflang]').map((link) => {
    const lang = (link.getAttribute('hreflang') || '').trim();
    let urlValid = true;
    try {
      new URL(link.href, location.href);
    } catch {
      urlValid = false;
    }
    const languageValid = lang.toLocaleLowerCase() === 'x-default' || /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(lang);
    return {
      lang,
      href: link.href,
      valid: languageValid && urlValid,
      locator: locatorFor(link),
    };
  });
}

function resourceKind(initiatorType: string, url: string): ResourceSnapshot['kind'] {
  if (initiatorType === 'script' || /\.m?js(?:$|[?#])/i.test(url)) return 'script';
  if (initiatorType === 'css' || /\.css(?:$|[?#])/i.test(url)) return 'stylesheet';
  if (initiatorType === 'img' || /\.(?:avif|gif|jpe?g|png|svg|webp)(?:$|[?#])/i.test(url)) return 'image';
  if (/\.(?:woff2?|otf|ttf)(?:$|[?#])/i.test(url)) return 'font';
  if (initiatorType === 'fetch' || initiatorType === 'xmlhttprequest') return 'fetch';
  return 'other';
}

function performanceResourceMap(): Map<string, PerformanceResourceTiming> {
  return new Map(
    performance.getEntriesByType('resource')
      .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
      .map((entry) => [entry.name, entry]),
  );
}

function timingValues(entry: PerformanceResourceTiming | undefined): Pick<ResourceSnapshot, 'transferSize' | 'encodedBodySize' | 'decodedBodySize' | 'duration'> {
  if (!entry) return { transferSize: null, encodedBodySize: null, decodedBodySize: null, duration: null };
  return {
    transferSize: entry.transferSize || null,
    encodedBodySize: entry.encodedBodySize || null,
    decodedBodySize: entry.decodedBodySize || null,
    duration: Number.isFinite(entry.duration) ? entry.duration : null,
  };
}

function collectResources(origin: string): ResourceSnapshot[] {
  const timings = performanceResourceMap();
  const resources: ResourceSnapshot[] = [];
  for (const script of deepQueryAll<HTMLScriptElement>('script')) {
    if ((script.type || '').toLocaleLowerCase() === 'application/ld+json') continue;
    const url = script.src || '';
    const module = script.type.toLocaleLowerCase() === 'module';
    const inHead = Boolean(script.closest('head'));
    resources.push({
      url,
      kind: 'script',
      async: script.async,
      defer: script.defer,
      module,
      blocking: inHead && !module && !script.async && !script.defer,
      inline: !url,
      inHead,
      ...timingValues(url ? timings.get(url) : undefined),
      decodedBodySize: url ? timingValues(timings.get(url)).decodedBodySize : new TextEncoder().encode(script.textContent || '').byteLength,
      thirdParty: Boolean(url && (() => { try { return new URL(url).origin !== origin; } catch { return false; } })()),
    });
  }
  for (const stylesheet of deepQueryAll<HTMLLinkElement>('link[rel~="stylesheet"]')) {
    const url = stylesheet.href;
    const media = stylesheet.media.trim().toLocaleLowerCase();
    resources.push({
      url,
      kind: 'stylesheet',
      async: false,
      defer: false,
      module: false,
      blocking: !stylesheet.disabled && (!media || media === 'all' || media === 'screen'),
      inline: false,
      inHead: Boolean(stylesheet.closest('head')),
      ...timingValues(timings.get(url)),
      thirdParty: (() => { try { return new URL(url).origin !== origin; } catch { return false; } })(),
    });
  }
  for (const style of deepQueryAll<HTMLStyleElement>('style')) {
    resources.push({
      url: '',
      kind: 'stylesheet',
      async: false,
      defer: false,
      module: false,
      blocking: false,
      inline: true,
      inHead: Boolean(style.closest('head')),
      transferSize: null,
      encodedBodySize: null,
      decodedBodySize: new TextEncoder().encode(style.textContent || '').byteLength,
      duration: null,
      thirdParty: false,
    });
  }
  const known = new Set(resources.filter((item) => item.url).map((item) => item.url));
  for (const entry of timings.values()) {
    if (known.has(entry.name)) continue;
    let thirdParty = false;
    try { thirdParty = new URL(entry.name).origin !== origin; } catch { /* Keep false for non-URL names. */ }
    resources.push({
      url: entry.name,
      kind: resourceKind(entry.initiatorType, entry.name),
      async: false,
      defer: false,
      module: false,
      blocking: false,
      inline: false,
      inHead: false,
      ...timingValues(entry),
      thirdParty,
    });
  }
  return resources.slice(0, 150);
}

function mixedContentUrls(): string[] {
  if (location.protocol !== 'https:') return [];
  const urls = deepQueryAll<HTMLElement>('[src],[href]')
    .flatMap((element) => [element.getAttribute('src'), element.getAttribute('href')])
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => { try { return [new URL(value, location.href)]; } catch { return []; } })
    .filter((url) => url.protocol === 'http:')
    .map((url) => url.href);
  return [...new Set(urls)].slice(0, 20);
}

function buildTechnicalDelivery(
  snapshot: Pick<PageSnapshot, 'siteProbe' | 'rawComparison' | 'links' | 'robotsMeta' | 'jsonLd' | 'templateType' | 'canonicals'>,
  collectedResources?: ResourceSnapshot[],
): TechnicalDeliveryProbe {
  const headers = snapshot.siteProbe.page.headers || EMPTY_RESPONSE_HEADERS;
  const resources = summarizeResources(collectedResources || collectResources(location.origin));
  const preferredHost = preferredSiteHost(location.href, snapshot.canonicals[0]);
  return {
    checkedAt: new Date().toISOString(),
    headers,
    transport: evaluateTransport({
      url: snapshot.siteProbe.page.finalUrl || location.href,
      preferredHost,
      hsts: location.protocol === 'https:' ? Boolean(headers.strictTransportSecurity) : null,
      mixedContentUrls: mixedContentUrls(),
    }),
    compression: assessCompression(
      snapshot.siteProbe.page.contentType,
      headers,
      snapshot.siteProbe.page.responseBodyBytes ?? null,
    ),
    cache: assessCache(snapshot.siteProbe.page.finalUrl || location.href, snapshot.siteProbe.page.contentType, headers),
    resources,
    links: summarizeLinkRels(snapshot.links, snapshot.robotsMeta),
    crawler: buildCrawlerAccess(snapshot),
    schemaSuggestions: buildSchemaSuggestions(snapshot.templateType, snapshot.jsonLd.flatMap((item) => item.types)),
    limitations: [
      '证书到期时间、证书链、TLS 版本和加密套件需要服务器级证据。',
      '未使用 CSS/JavaScript 需要 Coverage 或代码依赖分析，当前只标记加载风险候选。',
      '搜索爬虫可访问性使用匿名 GET，不等同于真实 Googlebot 身份验证。',
    ],
  };
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.8' },
    });
  } finally {
    clearTimeout(timeout);
  }
}

function rawDocumentText(doc: Document): string {
  doc.querySelectorAll('script,style,noscript,template').forEach((element) => element.remove());
  return visibleText(doc.body?.textContent, Number.MAX_SAFE_INTEGER);
}

async function probeSite(url: string, resourceUrls: string[]): Promise<{
  siteProbe: SiteProbeResult;
  rawComparison: PageSnapshot['rawComparison'];
}> {
  let rawComparison: PageSnapshot['rawComparison'] = {
    available: false,
    rawTitle: '',
    rawDescription: '',
    rawRobots: [],
    rawCanonicals: [],
    rawH1: [],
    rawH1Count: 0,
    rawTextLength: 0,
    renderedTextLength: visibleText(document.body?.innerText, Number.MAX_SAFE_INTEGER).length,
    rawInternalLinks: [],
    rawHreflangs: [],
    rawJsonLdCount: 0,
    differences: [],
    error: null,
  };
  const pageProbe: SiteProbeResult['page'] = {
    status: null,
    finalUrl: '',
    contentType: '',
    xRobotsTag: '',
    headers: EMPTY_RESPONSE_HEADERS,
    responseBodyBytes: null,
    error: null,
  };

  try {
    const response = await fetchWithTimeout(url.split('#')[0]!, 8000);
    const html = (await response.text()).slice(0, 2_000_000);
    const rawDocument = new DOMParser().parseFromString(html, 'text/html');
    const rawText = rawDocumentText(rawDocument);
    const rawTitle = rawDocument.title.trim();
    const rawDescription = rawDocument.querySelector<HTMLMetaElement>('meta[name="description" i]')?.content.trim() || '';
    const rawRobots = Array.from(rawDocument.querySelectorAll<HTMLMetaElement>('meta[name="robots" i],meta[name="googlebot" i]')).map((item) => item.content.trim());
    const rawCanonicals = Array.from(rawDocument.querySelectorAll<HTMLLinkElement>('link[rel~="canonical"]')).map((item) => item.getAttribute('href') || '');
    const rawH1 = Array.from(rawDocument.querySelectorAll('h1')).map((item) => visibleText(item.textContent, 240));
    const rawInternalLinks = Array.from(rawDocument.querySelectorAll<HTMLAnchorElement>('a[href]')).map((item) => item.href).filter((href) => {
      try { return new URL(href, url).origin === new URL(url).origin; } catch { return false; }
    });
    const rawHreflangs = Array.from(rawDocument.querySelectorAll<HTMLLinkElement>('link[rel~="alternate"][hreflang]')).map((item) => ({ lang: item.hreflang, href: item.href }));
    const rawJsonLdCount = rawDocument.querySelectorAll('script[type="application/ld+json" i]').length;
    const renderedTitle = document.title.trim();
    const renderedDescription = document.querySelector<HTMLMetaElement>('meta[name="description" i]')?.content.trim() || '';
    const differences = [
      rawTitle !== renderedTitle ? 'title' : '',
      rawDescription !== renderedDescription ? 'description' : '',
      rawRobots.join('|') !== Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="robots" i],meta[name="googlebot" i]')).map((item) => item.content.trim()).join('|') ? 'robots' : '',
      rawCanonicals.join('|') !== Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="canonical"]')).map((item) => item.getAttribute('href') || '').join('|') ? 'canonical' : '',
      rawH1.join('|') !== deepQueryAll<HTMLHeadingElement>('h1').map((item) => visibleText(item.innerText, 240)).join('|') ? 'H1' : '',
      rawText.length !== rawComparison.renderedTextLength ? '正文' : '',
      rawInternalLinks.length !== deepQueryAll<HTMLAnchorElement>('a[href]').filter((item) => { try { return new URL(item.href, url).origin === new URL(url).origin; } catch { return false; } }).length ? '内链' : '',
      rawHreflangs.length !== collectHreflangs().length ? 'hreflang' : '',
      rawJsonLdCount !== collectJsonLd().length ? 'JSON-LD' : '',
    ].filter(Boolean);
    pageProbe.status = response.status;
    pageProbe.finalUrl = response.url;
    pageProbe.contentType = response.headers.get('content-type') || '';
    pageProbe.xRobotsTag = response.headers.get('x-robots-tag') || '';
    pageProbe.headers = collectResponseHeaders(response.headers);
    pageProbe.responseBodyBytes = new TextEncoder().encode(html).byteLength;
    rawComparison = {
      available: true,
      rawTitle,
      rawDescription,
      rawRobots,
      rawCanonicals,
      rawH1,
      rawH1Count: rawH1.length,
      rawTextLength: rawText.length,
      renderedTextLength: rawComparison.renderedTextLength,
      rawInternalLinks,
      rawHreflangs,
      rawJsonLdCount,
      differences,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GET 请求失败';
    pageProbe.error = message;
    rawComparison.error = message;
  }

  const robotsUrl = `${location.origin}/robots.txt`;
  const robotsProbe: SiteProbeResult['robots'] = {
    status: null,
    url: robotsUrl,
    allowed: null,
    sitemaps: [],
    syntaxIssues: [],
    unknownDirectives: [],
    blockedResources: [],
    error: null,
  };
  let robotsText = '';
  try {
    const response = await fetchWithTimeout(robotsUrl, 5000);
    robotsProbe.status = response.status;
    if (response.status === 404) {
      robotsProbe.allowed = true;
    } else if (response.ok) {
      robotsText = (await response.text()).slice(0, 1_000_000);
      const policy = parseRobotsPolicy(robotsUrl, robotsText, url, 'Googlebot', resourceUrls);
      robotsProbe.allowed = policy.allowed;
      robotsProbe.sitemaps = policy.sitemaps;
      robotsProbe.agentAccess = policy.agentAccess;
      robotsProbe.syntaxIssues = policy.syntaxIssues;
      robotsProbe.unknownDirectives = policy.unknownDirectives;
      robotsProbe.blockedResources = policy.blockedResources;
    } else {
      robotsProbe.error = `robots.txt 返回 ${response.status}`;
    }
  } catch (error) {
    robotsProbe.error = error instanceof Error ? error.message : 'robots.txt 请求失败';
  }

  let sitemap: SitemapProbe | null = null;
  const sameOriginSitemaps = robotsProbe.sitemaps.filter((candidate) => {
    try {
      return new URL(candidate).origin === location.origin;
    } catch {
      return false;
    }
  });
  const sitemapUrl = sameOriginSitemaps[0] || `${location.origin}/sitemap.xml`;
  try {
    const response = await fetchWithTimeout(sitemapUrl, 5000);
    const contentType = response.headers.get('content-type') || '';
    let validXml: boolean | null = null;
    if (response.ok) {
      const xml = (await response.text()).slice(0, 2_000_000);
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      validXml = !doc.querySelector('parsererror');
    }
    sitemap = {
      url: sitemapUrl,
      status: response.status,
      validXml,
      contentType,
      error: response.ok ? null : `sitemap 返回 ${response.status}`,
    };
  } catch (error) {
    sitemap = {
      url: sitemapUrl,
      status: null,
      validXml: null,
      contentType: '',
      error: error instanceof Error ? error.message : 'sitemap 请求失败',
    };
  }

  return { siteProbe: { page: pageProbe, robots: robotsProbe, sitemap }, rawComparison };
}

async function collectPerformance(): Promise<PerformanceSnapshot> {
  let lcp: number | null = null;
  let cls: number | null = PerformanceObserver.supportedEntryTypes.includes('layout-shift') ? 0 : null;
  const observers: PerformanceObserver[] = [];

  const observe = (type: string, callback: (entries: PerformanceEntryList) => void) => {
    try {
      const observer = new PerformanceObserver((list) => callback(list.getEntries()));
      observer.observe({ type, buffered: true });
      observers.push(observer);
    } catch {
      // Unsupported metrics remain not measurable.
    }
  };

  observe('largest-contentful-paint', (entries) => {
    const last = entries.at(-1);
    if (last) lcp = last.startTime;
  });
  observe('layout-shift', (entries) => {
    cls = entries.reduce((total, entry) => {
      const shift = entry as LayoutShiftEntry;
      return total + (shift.hadRecentInput ? 0 : shift.value);
    }, cls ?? 0);
  });
  await new Promise((resolve) => setTimeout(resolve, 160));
  observers.forEach((observer) => observer.disconnect());
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const firstContentfulPaint = performance.getEntriesByName('first-contentful-paint')[0];

  return {
    lcp,
    cls,
    fcp: firstContentfulPaint?.startTime ?? null,
    ttfb: navigation ? Math.max(0, navigation.responseStart - navigation.requestStart) : null,
  };
}

async function collectPage(): Promise<PageSnapshot> {
  if (document.contentType === 'application/pdf') throw new Error('PDF 页面不支持 DOM SEO 审计。');
  const url = location.href;
  observedUrl = url;
  const origin = location.origin;
  const headings = deepQueryAll<HTMLHeadingElement>('h1,h2,h3,h4,h5,h6').map((heading) => ({
    level: Number(heading.tagName.slice(1)),
    text: visibleText(heading.innerText, 240),
    locator: locatorFor(heading),
  }));
  const jsonLd = collectJsonLd();
  const links = collectLinks(origin);
  const robotsMeta = Array.from(document.head.querySelectorAll<HTMLMetaElement>('meta[name="robots" i],meta[name="googlebot" i]')).map(
    (element) => element.content,
  );
  const canonicals = Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel~="canonical"]')).map(
    (element) => element.getAttribute('href') || '',
  );
  const classifiedTemplate = classifyUrlTemplate(url, document.title);
  const visibleBodyText = visibleText(document.body?.innerText, Number.MAX_SAFE_INTEGER);
  const collectedResources = collectResources(origin);
  const [{ siteProbe, rawComparison }, performanceSnapshot] = await Promise.all([
    probeSite(url, collectedResources.filter((item) => !item.inline && item.url).map((item) => item.url)),
    collectPerformance(),
  ]);

  const snapshot: PageSnapshot = {
    id: crypto.randomUUID(),
    url,
    origin,
    capturedAt: new Date().toISOString(),
    titleTags: Array.from(document.head.querySelectorAll('title')).map((element) => element.textContent || ''),
    descriptions: Array.from(document.head.querySelectorAll<HTMLMetaElement>('meta[name="description" i]')).map(
      (element) => element.content,
    ),
    robotsMeta,
    canonicals,
    hreflangs: collectHreflangs(),
    htmlLang: document.documentElement.lang,
    headings,
    mainCount: deepQueryAll('main,[role="main"]').length,
    formCount: deepQueryAll('form').length,
    ctaTexts: deepQueryAll<HTMLElement>('button,a,[role="button"]').map((element) => visibleText(element.innerText || element.getAttribute('aria-label'), 120)).filter(Boolean).slice(0, 50),
    visibleTextLength: visibleBodyText.length,
    visibleTextPreview: visibleBodyText.slice(0, 600),
    articleAuthorPresent: deepQueryAll('[rel="author"],[itemprop="author"],.author,[class*="author"]').length > 0,
    articleDatePresent: deepQueryAll('time[datetime],[itemprop="datePublished"],[itemprop="dateModified"]').length > 0,
    links,
    images: collectImages(),
    videos: collectVideos(),
    jsonLd,
    viewportMeta: document.head.querySelector<HTMLMetaElement>('meta[name="viewport" i]')?.content || '',
    openGraphCount: document.head.querySelectorAll('meta[property^="og:"]').length,
    twitterCardPresent: Boolean(document.head.querySelector('meta[name="twitter:card" i]')),
    rawComparison,
    performance: performanceSnapshot,
    siteProbe,
    limitations: [
      '仅分析当前顶层文档和可访问的 open shadow root',
      '跨域 iframe 与 closed shadow root 不可读取',
      '性能数据来自本次浏览会话，不是字段 Core Web Vitals',
    ],
    schemaValidation: jsonLd.flatMap((item) => item.schema ? [item.schema] : []),
    templateType: classifiedTemplate.type,
    titlePattern: classifiedTemplate.pattern,
  };
  snapshot.technical = buildTechnicalDelivery(snapshot, collectedResources);
  return snapshot;
}

function collectOverseasStatic(
  snapshot: PageSnapshot,
  settings: import('../src/lib/projects/types').InternationalProjectSettings,
  dataLayerEntries: unknown[],
  uetEntries: unknown[],
) {
  const scripts = Array.from(document.scripts);
  return buildOverseasStaticSnapshot(snapshot, settings, {
    scriptUrls: scripts.map((script) => script.src).filter(Boolean).slice(0, 150),
    inlineScriptText: scripts
      .filter((script) => !script.src)
      .map((script) => (script.textContent || '').slice(0, 2_000))
      .filter(Boolean)
      .slice(0, 80),
    resourceUrls: performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => /^https?:/i.test(url))
      .slice(0, 300),
    dataLayerEntries,
    uetEntries,
    currentUrl: location.href,
    finalUrl: snapshot.siteProbe.page.finalUrl || location.href,
  });
}

function updateOverlayPositions(state: OverlayState): void {
  state.frame = null;
  if (state.items.some((item) => !item.element.isConnected)) {
    clearOverlay();
    notifyPageStale();
    return;
  }
  for (const item of state.items) {
    const rect = item.element.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0;
    item.box.hidden = !visible;
    if (!visible) continue;
    item.box.style.transform = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px)`;
    item.box.style.width = `${Math.round(rect.width)}px`;
    item.box.style.height = `${Math.round(rect.height)}px`;
  }
}

function scheduleOverlayUpdate(state: OverlayState): void {
  if (state.frame !== null) return;
  state.frame = requestAnimationFrame(() => updateOverlayPositions(state));
}

function clearOverlay(): void {
  const globalState = globalThis as typeof globalThis & SeoOptGlobal;
  const state = globalState.__SEO_OPT_OVERLAY__;
  if (!state) return;
  state.abortController.abort();
  state.resizeObserver.disconnect();
  state.mutationObserver.disconnect();
  if (state.frame !== null) cancelAnimationFrame(state.frame);
  state.host.remove();
  delete globalState.__SEO_OPT_OVERLAY__;
}

function showOverlay(findings: AuditFinding[], selectedId: string | null, scroll: boolean): number {
  clearOverlay();
  const visibleFindings = findings
    .filter((finding) => finding.locator && (finding.status === 'failure' || finding.status === 'warning'))
    .slice(0, 40);
  const resolved = visibleFindings
    .map((finding) => ({ finding, element: resolveLocator(finding.locator!) }))
    .filter((item): item is { finding: AuditFinding; element: Element } => Boolean(item.element));
  if (resolved.length === 0) return 0;

  const host = document.createElement('div');
  host.id = 'seo-opt-overlay-root';
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { --seo-opt-blue: #2563eb; --seo-opt-red: #dc2626; --seo-opt-white: #fff; }
    .box { position: fixed; left: 0; top: 0; border: 2px solid var(--seo-opt-red); background: rgb(220 38 38 / 8%); box-sizing: border-box; pointer-events: none; }
    .box.selected { border-color: var(--seo-opt-blue); background: rgb(37 99 235 / 10%); box-shadow: 0 0 0 3px rgb(37 99 235 / 24%); }
    .badge { position: absolute; top: -13px; left: -2px; min-width: 24px; height: 24px; padding: 0 6px; display: grid; place-items: center; border-radius: 4px; background: var(--seo-opt-red); color: var(--seo-opt-white); font: 600 12px/1 system-ui, sans-serif; }
    .selected .badge { background: var(--seo-opt-blue); }
  `;
  shadow.append(style);

  const items: OverlayItem[] = resolved.map(({ finding, element }, index) => {
    const box = document.createElement('div');
    box.className = `box${finding.id === selectedId ? ' selected' : ''}`;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = String(index + 1);
    box.append(badge);
    shadow.append(box);
    return { finding, element, box };
  });
  document.documentElement.append(host);

  const abortController = new AbortController();
  let state: OverlayState;
  const resizeObserver = new ResizeObserver(() => scheduleOverlayUpdate(state));
  const mutationObserver = new MutationObserver(() => scheduleOverlayUpdate(state));
  state = { host, items, abortController, resizeObserver, mutationObserver, frame: null };
  const globalState = globalThis as typeof globalThis & SeoOptGlobal;
  globalState.__SEO_OPT_OVERLAY__ = state;
  items.forEach((item) => resizeObserver.observe(item.element));
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('scroll', () => scheduleOverlayUpdate(state), {
    capture: true,
    passive: true,
    signal: abortController.signal,
  });
  addEventListener('resize', () => scheduleOverlayUpdate(state), {
    passive: true,
    signal: abortController.signal,
  });
  updateOverlayPositions(state);

  if (scroll && selectedId) {
    const selected = items.find((item) => item.finding.id === selectedId)?.element;
    selected?.scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'center',
      inline: 'nearest',
    });
  }
  return items.length;
}

export default defineUnlistedScript(() => {
  const globalState = globalThis as typeof globalThis & SeoOptGlobal;
  if (globalState.__SEO_OPT_INSTALLED__) return;
  globalState.__SEO_OPT_INSTALLED__ = true;

  type SafeTrackingObservation = import('../src/lib/projects/types').TrackingObservation;
  const trackingQueue: Array<{ testId: string; observation: SafeTrackingObservation; attempts: number }> = [];
  let trackingFlushTimer: number | null = null;
  let trackingFlushInFlight = false;

  const scheduleTrackingFlush = (delay = 40) => {
    if (trackingFlushTimer !== null) return;
    trackingFlushTimer = window.setTimeout(() => {
      trackingFlushTimer = null;
      void flushTrackingQueue();
    }, delay);
  };

  const flushTrackingQueue = async (preferredTestId?: string, scheduleNext = true): Promise<void> => {
    if (trackingFlushInFlight || !trackingQueue.length) return;
    trackingFlushInFlight = true;
    const testId = preferredTestId && trackingQueue.some((entry) => entry.testId === preferredTestId)
      ? preferredTestId
      : trackingQueue[0]!.testId;
    const batchEntries = trackingQueue.filter((entry) => entry.testId === testId).slice(0, 20);
    for (const entry of batchEntries) trackingQueue.splice(trackingQueue.indexOf(entry), 1);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'TRACKING_OBSERVATION_BATCH',
        testId,
        observations: batchEntries.map((entry) => entry.observation),
      } satisfies RuntimeMessage) as { ok?: boolean; result?: { accepted?: number } } | undefined;
      if (!response?.ok || response.result?.accepted !== batchEntries.length) {
        throw new Error('Tracking batch was not fully acknowledged');
      }
    } catch {
      const retryable = batchEntries
        .filter((entry) => entry.attempts < 1)
        .map((entry) => ({ ...entry, attempts: entry.attempts + 1 }));
      trackingQueue.unshift(...retryable);
    } finally {
      trackingFlushInFlight = false;
      if (scheduleNext && trackingQueue.length) {
        scheduleTrackingFlush(batchEntries.some((entry) => entry.attempts < 1) ? 120 : 40);
      }
    }
  };

  chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
    if (message.type === 'COLLECT_PAGE') {
      collectPage()
        .then((snapshot) => sendResponse({ ok: true, snapshot }))
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : '页面采集失败' }));
      return true;
    }
    if (message.type === 'COLLECT_AI_SNIPPET') {
      sendResponse({
        ok: true,
        snippet: visibleText(document.body?.innerText, 4_000),
      });
      return false;
    }
    if (message.type === 'COLLECT_OVERSEAS_STATIC') {
      sendResponse({
        ok: true,
        overseas: collectOverseasStatic(message.snapshot, message.settings, message.dataLayerEntries, message.uetEntries),
      });
      return false;
    }
    if (message.type === 'SHOW_OVERLAY') {
      sendResponse({ ok: true, count: showOverlay(message.findings, message.selectedId, message.scroll) });
      return false;
    }
    if (message.type === 'CLEAR_OVERLAY') {
      clearOverlay();
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === 'FLUSH_TRACKING_OBSERVATIONS') {
      void (async () => {
        if (trackingFlushTimer !== null) {
          clearTimeout(trackingFlushTimer);
          trackingFlushTimer = null;
        }
        while (trackingFlushInFlight) await new Promise((resolve) => setTimeout(resolve, 10));
        while (trackingQueue.some((entry) => entry.testId === message.testId)) {
          await flushTrackingQueue(message.testId, false);
          while (trackingFlushInFlight) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (trackingQueue.length) scheduleTrackingFlush();
        sendResponse({ ok: !trackingQueue.some((entry) => entry.testId === message.testId) });
      })();
      return true;
    }
    return false;
  });

  document.addEventListener('seo-opt:tracking-observation', (event) => {
    const detail = (event as CustomEvent).detail as { testId?: unknown; observation?: unknown } | null;
    if (!detail || typeof detail.testId !== 'string' || !detail.observation || typeof detail.observation !== 'object') return;
    const raw = detail.observation as Record<string, unknown>;
    if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.relativeMs !== 'number') return;
    const allowedPlatforms = ['google_analytics', 'google_tag_manager', 'google_ads', 'bing_uet', 'microsoft_clarity', 'browser'];
    const allowedTypes = ['initialization', 'request', 'event', 'route', 'consent'];
    if (!allowedPlatforms.includes(String(raw.platform)) || !allowedTypes.includes(String(raw.type))) return;
    const fields = raw.fields && typeof raw.fields === 'object' ? raw.fields as Record<string, unknown> : {};
    const observation: SafeTrackingObservation = {
      id: raw.id.slice(0, 80),
      platform: raw.platform as import('../src/lib/projects/types').TrackingObservation['platform'],
      type: raw.type as import('../src/lib/projects/types').TrackingObservation['type'],
      name: raw.name.slice(0, 100),
      relativeMs: Math.max(0, Math.round(raw.relativeMs)),
      fields: {
        eventId: fields.eventId === true,
        transactionId: fields.transactionId === true,
        value: fields.value === true,
        currency: fields.currency === true,
        items: fields.items === true,
        sensitiveField: fields.sensitiveField === true,
        ...(typeof fields.targetId === 'string' ? { targetId: fields.targetId.slice(0, 40) } : {}),
      },
    };
    trackingQueue.push({ testId: detail.testId, observation, attempts: 0 });
    scheduleTrackingFlush();
  });
  document.addEventListener('seo-opt:tracking-stopped', (event) => {
    const testId = (event as CustomEvent).detail?.testId;
    if (typeof testId !== 'string') return;
    void chrome.runtime.sendMessage({ type: 'TRACKING_OBSERVER_STOPPED', testId } satisfies RuntimeMessage).catch(() => undefined);
  });

  addEventListener('pagehide', clearOverlay, { once: true });
  addEventListener('popstate', clearOverlay);
  addEventListener('hashchange', clearOverlay);
  window.setInterval(() => {
    if (location.href === observedUrl) return;
    observedUrl = location.href;
    clearOverlay();
    notifyPageStale();
  }, 500);
});
