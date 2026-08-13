import { getDomain } from 'tldts';

import type {
  CacheAssessment,
  CompressionAssessment,
  CrawlerAccessSummary,
  LinkRelSummary,
  LinkSnapshot,
  PageSnapshot,
  RedirectVariantResult,
  ResourceAuditSummary,
  ResourceSnapshot,
  ResponseHeaderSnapshot,
  SchemaSuggestion,
  TechnicalSignalStatus,
  TransportSecuritySnapshot,
} from './types';

const TEXT_CONTENT = /(?:text\/|javascript|json|xml|svg)/i;
const ALREADY_COMPRESSED = /(?:image\/(?:avif|gif|jpeg|png|webp)|video\/|audio\/|font\/woff2?)/i;
const HASHED_FILENAME = /(?:^|[._-])[a-f0-9_-]{8,}(?=[._-]|$)/i;

export const EMPTY_RESPONSE_HEADERS: ResponseHeaderSnapshot = {
  contentEncoding: null,
  contentLength: null,
  cacheControl: null,
  expires: null,
  etag: null,
  lastModified: null,
  vary: null,
  age: null,
  strictTransportSecurity: null,
};

export function collectResponseHeaders(headers: Headers): ResponseHeaderSnapshot {
  const length = Number(headers.get('content-length'));
  return {
    contentEncoding: headers.get('content-encoding'),
    contentLength: Number.isFinite(length) && length >= 0 ? length : null,
    cacheControl: headers.get('cache-control'),
    expires: headers.get('expires'),
    etag: headers.get('etag'),
    lastModified: headers.get('last-modified'),
    vary: headers.get('vary'),
    age: headers.get('age'),
    strictTransportSecurity: headers.get('strict-transport-security'),
  };
}

export function assessCompression(
  contentType: string,
  headers: ResponseHeaderSnapshot,
  fallbackBytes: number | null = null,
): CompressionAssessment {
  const bytes = headers.contentLength ?? fallbackBytes;
  if (ALREADY_COMPRESSED.test(contentType) || !TEXT_CONTENT.test(contentType)) {
    return {
      status: 'good',
      applicable: false,
      encoding: headers.contentEncoding,
      bytes,
      explanation: '该资源类型通常已经压缩，不机械要求再启用 gzip 或 Brotli。',
    };
  }
  if ((bytes ?? 0) <= 1_024) {
    return {
      status: 'good',
      applicable: true,
      encoding: headers.contentEncoding,
      bytes,
      explanation: '响应体很小，额外压缩的收益有限。',
    };
  }
  if (/\b(?:br|gzip)\b/i.test(headers.contentEncoding || '')) {
    return {
      status: 'good',
      applicable: true,
      encoding: headers.contentEncoding,
      bytes,
      explanation: `响应声明使用 ${headers.contentEncoding} 压缩。`,
    };
  }
  return {
    status: 'attention',
    applicable: true,
    encoding: headers.contentEncoding,
    bytes,
    explanation: '文本响应超过 1KB，但没有发现 gzip 或 Brotli 响应头。',
  };
}

function cacheMaxAge(value: string | null): number | null {
  const match = value?.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function isVersionedAsset(url: string): boolean {
  try {
    const filename = new URL(url).pathname.split('/').at(-1) || '';
    return HASHED_FILENAME.test(filename);
  } catch {
    return false;
  }
}

export function assessCache(
  url: string,
  contentType: string,
  headers: ResponseHeaderSnapshot,
): CacheAssessment {
  const control = headers.cacheControl?.toLocaleLowerCase() || '';
  const maxAgeSeconds = cacheMaxAge(control);
  const hasValidator = Boolean(headers.etag || headers.lastModified);
  const html = /html|xhtml/i.test(contentType);
  const staticAsset = /(?:javascript|css|font|image)/i.test(contentType);

  if (/\bno-store\b/.test(control)) {
    return {
      status: html ? 'confirm' : 'attention',
      policy: 'no_store',
      maxAgeSeconds,
      hasValidator,
      explanation: html
        ? '页面禁止缓存；登录态或敏感页面通常合理，公开静态页面则可能重复下载。'
        : '静态资源禁止缓存，会增加重复下载和加载成本。',
    };
  }
  if (/\bprivate\b/.test(control)) {
    return {
      status: html ? 'confirm' : 'attention',
      policy: 'private',
      maxAgeSeconds,
      hasValidator,
      explanation: html ? '页面仅允许浏览器私有缓存，需要结合是否登录或个性化确认。' : '静态资源使用私有缓存，需要确认是否有用户差异。',
    };
  }
  if (staticAsset && isVersionedAsset(url) && (maxAgeSeconds ?? 0) >= 2_592_000 && /\bimmutable\b/.test(control)) {
    return {
      status: 'good',
      policy: 'long_immutable',
      maxAgeSeconds,
      hasValidator,
      explanation: '版本化静态资源使用长期缓存和 immutable，更新时可通过文件名换版本。',
    };
  }
  if (staticAsset && isVersionedAsset(url) && (maxAgeSeconds ?? 0) < 2_592_000) {
    return {
      status: 'attention',
      policy: 'unclear',
      maxAgeSeconds,
      hasValidator,
      explanation: '资源文件名包含版本指纹，但缓存时间不足 30 天，未充分利用长期缓存。',
    };
  }
  if (staticAsset && !isVersionedAsset(url) && (maxAgeSeconds ?? 0) > 604_800 && !hasValidator) {
    return {
      status: 'confirm',
      policy: 'unclear',
      maxAgeSeconds,
      hasValidator,
      explanation: '未版本化资源使用超过 7 天的缓存且没有验证器，发布更新后可能继续使用旧文件。',
    };
  }
  if (html && /\bpublic\b/.test(control) && (maxAgeSeconds ?? 0) > 86_400) {
    return {
      status: 'confirm',
      policy: 'unclear',
      maxAgeSeconds,
      hasValidator,
      explanation: 'HTML 使用超过 1 天的公共缓存，需要确认页面是否长期静态以及 CDN 更新策略。',
    };
  }
  if (/\bno-cache\b/.test(control) || maxAgeSeconds === 0 || hasValidator) {
    return {
      status: 'good',
      policy: 'revalidate',
      maxAgeSeconds,
      hasValidator,
      explanation: '响应支持重新验证，内容未变化时可以减少重复传输。',
    };
  }
  return {
    status: 'confirm',
    policy: 'unclear',
    maxAgeSeconds,
    hasValidator,
    explanation: '没有足够响应头判断缓存策略是否符合内容更新频率。',
  };
}

export function summarizeResources(resources: ResourceSnapshot[]): ResourceAuditSummary {
  const urls = resources.filter((item) => !item.inline && item.url).map((item) => item.url);
  const duplicates = [...new Set(urls.filter((url, index) => urls.indexOf(url) !== index))];
  const measurableTransfers = resources
    .map((item) => item.transferSize)
    .filter((value): value is number => value !== null && value > 0);
  return {
    total: resources.length,
    blockingScripts: resources.filter((item) => item.kind === 'script' && item.blocking).length,
    blockingStylesheets: resources.filter((item) => item.kind === 'stylesheet' && item.blocking).length,
    duplicateUrls: duplicates,
    thirdParty: resources.filter((item) => item.thirdParty).length,
    unmeasurableSizes: resources.filter((item) => !item.inline && (item.transferSize === null || item.transferSize === 0)).length,
    transferBytes: measurableTransfers.length ? measurableTransfers.reduce((total, value) => total + value, 0) : null,
    resources,
  };
}

export function summarizeLinkRels(links: LinkSnapshot[], robotsMeta: string[]): LinkRelSummary {
  const nofollow = (link: LinkSnapshot) => link.rel.includes('nofollow');
  return {
    total: links.length,
    internalNofollow: links.filter((link) => link.isInternal && nofollow(link)).length,
    externalNofollow: links.filter((link) => !link.isInternal && nofollow(link)).length,
    ugc: links.filter((link) => link.rel.includes('ugc')).length,
    sponsored: links.filter((link) => link.rel.includes('sponsored')).length,
    pageNofollow: robotsMeta.some((value) => /(?:^|[,;\s])(?:nofollow|none)(?:$|[,;\s])/i.test(value)),
  };
}

export function buildCrawlerAccess(snapshot: Pick<PageSnapshot, 'siteProbe' | 'rawComparison'>): CrawlerAccessSummary {
  const { page, robots } = snapshot.siteProbe;
  const raw = snapshot.rawComparison;
  const rawHasMainContent = raw.available ? raw.rawTextLength >= 200 : null;
  let status: TechnicalSignalStatus = 'good';
  let explanation = '匿名 GET、robots.txt 和原始 HTML 没有发现明显访问阻断。';
  if (page.status === null || !raw.available) {
    status = 'unavailable';
    explanation = page.error || raw.error || '没有获得匿名 GET 和原始 HTML 证据。';
  } else if (page.status >= 400 || robots.allowed === false) {
    status = 'attention';
    explanation = page.status >= 400 ? `匿名 GET 返回 ${page.status}。` : 'robots.txt 阻止当前路径。';
  } else if ((robots.blockedResources?.length || 0) > 0 || (robots.syntaxIssues?.length || 0) > 0) {
    status = 'confirm';
    explanation = robots.blockedResources?.length
      ? `robots.txt 可能阻止 ${robots.blockedResources.length} 个当前页面 CSS、JavaScript 或图片资源。`
      : 'robots.txt 存在格式风险，需确认搜索引擎是否按预期解析。';
  } else if (!raw.rawTitle || !raw.rawH1Count || !rawHasMainContent || !raw.rawInternalLinks.length) {
    status = 'confirm';
    explanation = '页面可以访问，但原始 HTML 缺少标题、主标题、主要正文或内部链接中的至少一项。';
  }
  return {
    status,
    confidence: page.status === null || !raw.available ? 'low' : 'high',
    statusCode: page.status,
    robotsAllowed: robots.allowed,
    rawHasTitle: raw.available ? Boolean(raw.rawTitle) : null,
    rawHasH1: raw.available ? raw.rawH1Count > 0 : null,
    rawHasMainContent,
    rawHasCanonical: raw.available ? raw.rawCanonicals.length > 0 : null,
    rawHasInternalLinks: raw.available ? raw.rawInternalLinks.length > 0 : null,
    renderDependentFields: raw.differences,
    ...(robots.agentAccess ? { agentAccess: robots.agentAccess } : {}),
    blockedResourceCount: robots.blockedResources?.length || 0,
    robotsSyntaxIssueCount: robots.syntaxIssues?.length || 0,
    explanation,
  };
}

function schemaTemplate(type: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ '@context': 'https://schema.org', '@type': type, ...fields }, null, 2);
}

export function buildSchemaSuggestions(
  pageType: PageSnapshot['templateType'] | undefined,
  existingTypes: string[],
): SchemaSuggestion[] {
  const existing = new Set(existingTypes.map((type) => type.toLocaleLowerCase()));
  const suggestions: SchemaSuggestion[] = [];
  const add = (suggestion: SchemaSuggestion) => {
    if (!existing.has(suggestion.schemaType.toLocaleLowerCase())) suggestions.push(suggestion);
  };
  if (pageType === 'article') {
    add({
      pageType,
      schemaType: 'Article',
      reason: '当前页面具有文章模板特征，可用结构化数据说明标题、作者和更新时间。',
      requiredRealFields: ['headline', 'author', 'datePublished'],
      optionalFields: ['dateModified', 'image', 'publisher'],
      exampleJsonLd: schemaTemplate('Article', { headline: '{{真实文章标题}}', author: { '@type': 'Person', name: '{{真实作者}}' }, datePublished: '{{ISO 日期}}' }),
      warnings: ['作者、日期和图片必须能在页面中看到或核实。'],
    });
  }
  if (pageType === 'product') {
    add({
      pageType,
      schemaType: 'Product',
      reason: '当前页面具有产品模板特征，可描述真实产品和销售信息。',
      requiredRealFields: ['name', 'image'],
      optionalFields: ['description', 'brand', 'offers', 'sku'],
      exampleJsonLd: schemaTemplate('Product', { name: '{{真实产品名称}}', image: ['{{真实产品图片绝对地址}}'], offers: { '@type': 'Offer', price: '{{真实价格}}', priceCurrency: '{{真实币种}}', availability: '{{真实库存状态}}' } }),
      warnings: ['不要创建页面没有展示的价格、库存、评分或评论。'],
    });
  }
  if (pageType === 'home') {
    add({
      pageType,
      schemaType: 'Organization',
      reason: '首页适合说明真实品牌、组织名称和官方联系信息。',
      requiredRealFields: ['name', 'url'],
      optionalFields: ['logo', 'sameAs', 'contactPoint'],
      exampleJsonLd: schemaTemplate('Organization', { name: '{{真实组织名称}}', url: '{{网站正式地址}}', logo: '{{真实 Logo 绝对地址}}' }),
      warnings: ['不要添加无法证明的官方账号、资质或奖项。'],
    });
  }
  if (pageType && !['home', 'search', 'filter', 'other'].includes(pageType)) {
    add({
      pageType,
      schemaType: 'BreadcrumbList',
      reason: '层级页面可用面包屑说明它在网站结构中的位置。',
      requiredRealFields: ['itemListElement'],
      optionalFields: [],
      exampleJsonLd: schemaTemplate('BreadcrumbList', { itemListElement: [{ '@type': 'ListItem', position: 1, name: '{{真实栏目名称}}', item: '{{真实栏目地址}}' }] }),
      warnings: ['顺序和名称必须与页面可见导航保持一致。'],
    });
  }
  return suggestions;
}

export function preferredSiteHost(url: string, canonical?: string): string | null {
  try {
    const current = new URL(url);
    if (canonical) {
      const canonicalUrl = new URL(canonical, current);
      if (getDomain(canonicalUrl.hostname, { allowPrivateDomains: true }) === getDomain(current.hostname, { allowPrivateDomains: true })) {
        return canonicalUrl.hostname;
      }
    }
    return current.hostname;
  } catch {
    return null;
  }
}

export function buildSiteEntryUrls(url: string): string[] {
  try {
    const current = new URL(url);
    if (/^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[a-f0-9:]+\])$/i.test(current.hostname)) return [];
    const domain = getDomain(current.hostname, { allowPrivateDomains: true });
    if (!domain) return [];
    if (current.hostname !== domain && current.hostname !== `www.${domain}`) {
      return [`http://${current.hostname}/`, `https://${current.hostname}/`];
    }
    return [
      `http://${domain}/`,
      `https://${domain}/`,
      `http://www.${domain}/`,
      `https://www.${domain}/`,
    ];
  } catch {
    return [];
  }
}

export function evaluateTransport(input: {
  url: string;
  preferredHost: string | null;
  hsts: boolean | null;
  mixedContentUrls: string[];
  variants?: RedirectVariantResult[];
}): TransportSecuritySnapshot {
  const protocol = (() => { try { return new URL(input.url).protocol; } catch { return ''; } })();
  const variants = input.variants || [];
  let status: TechnicalSignalStatus = protocol === 'https:' ? 'good' : 'attention';
  let explanation = protocol === 'https:' ? '当前页面使用 HTTPS。' : '当前页面没有使用 HTTPS。';
  if (input.mixedContentUrls.length) {
    status = 'attention';
    explanation = `HTTPS 页面仍引用 ${input.mixedContentUrls.length} 个 HTTP 资源。`;
  }
  if (variants.length) {
    const successful = variants.filter((item) => item.status !== null && item.status < 400 && item.finalUrl);
    const downgrade = successful.some((item) => new URL(item.finalUrl).protocol !== 'https:');
    const hosts = new Set(successful.map((item) => new URL(item.finalUrl).hostname));
    const wrongHost = input.preferredHost && successful.some((item) => new URL(item.finalUrl).hostname !== input.preferredHost);
    const chainRisk = variants.some((item) => item.redirectCount > 3 || /循环|过多/.test(item.error || ''));
    if (downgrade || wrongHost || hosts.size > 1 || chainRisk) {
      status = 'attention';
      explanation = downgrade
        ? '至少一个网站入口最终仍使用 HTTP。'
        : wrongHost || hosts.size > 1
          ? '多个网站入口没有统一到同一个正式主机。'
          : '入口存在过长或循环跳转。';
    } else if (successful.length < 2 || variants.some((item) => !item.chainComplete)) {
      status = status === 'attention' ? status : 'confirm';
      explanation = '入口检查证据不完整，需要结合服务器配置确认。';
    } else {
      status = 'good';
      explanation = '可访问入口均统一到同一个 HTTPS 正式地址。';
    }
  }
  return {
    status,
    currentProtocol: protocol,
    secureContext: protocol === 'https:',
    preferredHost: input.preferredHost,
    hsts: input.hsts,
    mixedContentUrls: input.mixedContentUrls,
    variants,
    certificateDetails: 'not_available',
    explanation,
  };
}
