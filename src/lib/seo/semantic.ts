import type { PageTemplateType, SchemaValidationResult } from '../projects/types';

type JsonRecord = Record<string, unknown>;

function records(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.flatMap(records);
  if (!value || typeof value !== 'object') return [];
  const record = value as JsonRecord;
  const graph = Array.isArray(record['@graph']) ? record['@graph'] : [];
  return [record, ...graph.flatMap(records)];
}

function typesOf(value: unknown): string[] {
  return [...new Set(records(value).flatMap((record) => {
    const type = record['@type'];
    return Array.isArray(type) ? type.filter((item): item is string => typeof item === 'string') : typeof type === 'string' ? [type] : [];
  }))];
}

function firstText(record: JsonRecord, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function pageTypeFor(types: string[]): PageTemplateType | 'unknown' {
  if (types.some((type) => /article|newsarticle|blogposting/i.test(type))) return 'article';
  if (types.some((type) => /product|service|softwareapplication|webapplication/i.test(type))) return 'product';
  if (types.some((type) => /collectionpage|itemlist|searchresultspage/i.test(type))) return 'category';
  if (types.some((type) => /organization|localbusiness/i.test(type))) return 'other';
  return 'unknown';
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function addMissing(issues: SchemaValidationResult['issues'], record: JsonRecord, field: string, label: string, severity: 'warning' | 'error' = 'warning'): void {
  if (!firstText(record, field) && record[field] === undefined) issues.push({ code: `missing-${field}`, severity, message: `${label}未提供`, field });
}

export function validateJsonLd(value: unknown, visible: { title?: string; authorPresent?: boolean; datePresent?: boolean } = {}): SchemaValidationResult {
  const types = typesOf(value);
  const pageType = pageTypeFor(types);
  const issues: SchemaValidationResult['issues'] = [];
  const visibleMismatchFields: string[] = [];
  const entities = records(value);

  if (!entities.length) {
    return { validSyntax: false, types: [], pageType: 'unknown', issues: [{ code: 'empty-entity', severity: 'error', message: 'JSON-LD 没有可识别实体' }], visibleMismatchFields };
  }

  for (const record of entities) {
    const typeText = typesOf(record).join(',').toLocaleLowerCase();
    if (/article|newsarticle|blogposting/.test(typeText)) {
      addMissing(issues, record, 'headline', '文章标题');
      addMissing(issues, record, 'datePublished', '发布时间');
      const published = firstText(record, 'datePublished');
      if (published && !isIsoDate(published)) issues.push({ code: 'date-published-format', severity: 'error', message: 'datePublished 不是标准 ISO 日期', field: 'datePublished' });
      const modified = firstText(record, 'dateModified');
      if (modified && !isIsoDate(modified)) issues.push({ code: 'date-modified-format', severity: 'error', message: 'dateModified 不是标准 ISO 日期', field: 'dateModified' });
      const author = record.author;
      if (!author || (typeof author === 'object' && !firstText(author as JsonRecord, 'name'))) issues.push({ code: 'author-name', severity: 'warning', message: '作者没有可见姓名', field: 'author' });
      if (!firstText(record, 'dateModified')) issues.push({ code: 'date-modified', severity: 'warning', message: '未提供 dateModified', field: 'dateModified' });
      if (!record.image) issues.push({ code: 'article-image', severity: 'warning', message: '文章未提供 image', field: 'image' });
      if (visible.title && firstText(record, 'headline') && firstText(record, 'headline') !== visible.title) visibleMismatchFields.push('headline');
      if (visible.authorPresent === false && record.author) visibleMismatchFields.push('author');
      if (visible.datePresent === false && (record.datePublished || record.dateModified)) visibleMismatchFields.push('date');
    }
    if (/product/.test(typeText)) {
      addMissing(issues, record, 'name', '商品名称');
      if (visible.title && firstText(record, 'name') && firstText(record, 'name') !== visible.title) visibleMismatchFields.push('name');
      const offers = record.offers;
      if (!offers) issues.push({ code: 'product-offers', severity: 'warning', message: '商品未提供 offers', field: 'offers' });
      else {
        const offer = Array.isArray(offers) ? offers[0] : offers;
        if (offer && typeof offer === 'object') {
          addMissing(issues, offer as JsonRecord, 'price', '商品价格');
          addMissing(issues, offer as JsonRecord, 'priceCurrency', '价格币种');
          addMissing(issues, offer as JsonRecord, 'availability', '库存状态');
          const price = (offer as JsonRecord).price;
          if (price !== undefined && (!Number.isFinite(Number(price)) || Number(price) < 0)) issues.push({ code: 'product-price-format', severity: 'error', message: '商品价格不是有效的非负数值', field: 'price' });
          const currency = firstText(offer as JsonRecord, 'priceCurrency');
          if (currency && !/^[A-Z]{3}$/.test(currency)) issues.push({ code: 'product-currency-format', severity: 'error', message: 'priceCurrency 应使用三位大写币种代码', field: 'priceCurrency' });
          const availability = firstText(offer as JsonRecord, 'availability');
          if (availability && !/(?:https?:\/\/schema\.org\/)?(?:InStock|OutOfStock|PreOrder|BackOrder|Discontinued|LimitedAvailability|OnlineOnly|InStoreOnly|PreSale|SoldOut)$/i.test(availability)) issues.push({ code: 'product-availability-format', severity: 'warning', message: 'availability 不是可识别的 Schema.org 库存状态', field: 'availability' });
        }
      }
      if (record.aggregateRating && !record.review) issues.push({ code: 'rating-without-review', severity: 'warning', message: '评分没有对应评价来源', field: 'aggregateRating' });
    }
    if (/organization|localbusiness/.test(typeText)) {
      addMissing(issues, record, 'name', '组织名称');
      addMissing(issues, record, 'url', '组织官网');
      if (!record.logo) issues.push({ code: 'organization-logo', severity: 'warning', message: '组织未提供 logo', field: 'logo' });
    }
    if (/breadcrumblist/.test(typeText) && !record.itemListElement) issues.push({ code: 'breadcrumb-items', severity: 'warning', message: '面包屑没有 itemListElement', field: 'itemListElement' });
  }

  return { validSyntax: true, types, pageType, issues, visibleMismatchFields: [...new Set(visibleMismatchFields)] };
}

export function classifyUrlTemplate(urlValue: string, title = ''): { key: string; type: PageTemplateType; pattern: string } {
  try {
    const url = new URL(urlValue);
    const query = url.searchParams;
    const path = url.pathname.toLocaleLowerCase();
    const search = query.has('q') || query.has('query') || /(?:^|\/)search(?:\/|$)/.test(path);
    const tag = /(?:^|\/)(?:tag|tags)(?:\/|$)/.test(path);
    const pageMatch = path.match(/(?:^|[\/_.-])(?:page|p)[-_]?(\d+)(?:\.html)?\/?$/i) || query.get('page')?.match(/^(\d+)$/);
    const filter = [...query.keys()].some((key) => /filter|sort|facet|category|brand|price/i.test(key));
    const type: PageTemplateType = search ? 'search' : tag ? 'tag' : pageMatch && Number(pageMatch[1]) > 1 ? 'pagination' : filter ? 'filter' : /product|service/.test(path) ? 'product' : /category|catalog|list|archive/.test(path) ? 'category' : /article|post|blog|\.html$/.test(path) ? 'article' : 'other';
    const staticSegments = new Set(['article', 'articles', 'post', 'posts', 'blog', 'product', 'products', 'service', 'services', 'category', 'categories', 'catalog', 'list', 'archive', 'tag', 'tags', 'search', 'page', 'p']);
    const segments = path.split('/').filter(Boolean);
    const templateSegments = segments.map((segment, index) => {
      if (/^\d+$/.test(segment)) return ':n';
      if (/^[a-f0-9]{8,}$/i.test(segment)) return ':id';
      if (staticSegments.has(segment)) return segment;
      const dynamicType = type === 'article' || type === 'product' || type === 'category' || type === 'tag';
      if (dynamicType && (index === segments.length - 1 || staticSegments.has(segments[index - 1] || ''))) return ':slug';
      return segment.replace(/\d+/g, ':n').replace(/[a-f0-9]{8,}/gi, ':id');
    });
    const queryPattern = type === 'pagination' ? '?page=:n' : type === 'filter' ? `?${[...query.keys()].sort().join('&')}` : '';
    const pattern = `/${templateSegments.join('/')}${path.endsWith('/') && templateSegments.length ? '/' : ''}${queryPattern}`;
    return { key: `${type}:${pattern}`, type, pattern };
  } catch {
    return { key: 'other:invalid', type: 'other', pattern: title || 'invalid' };
  }
}

export function normalizedAltRisk(alt: string | null, title: string, insideLink: boolean, allAlts: string[] = []): 'missing' | 'empty-link' | 'title-copy' | 'filename' | 'repeated' | 'context-mismatch' | null {
  if (alt === null) return 'missing';
  const value = alt.trim();
  if (!value && insideLink) return 'empty-link';
  if (!value) return null;
  if (title.trim() && value === title.trim()) return 'title-copy';
  if (/^(?:img|image|photo|picture)[-_ ]?\d*\.(?:jpe?g|png|gif|webp|avif)$/i.test(value) || /\.(?:jpe?g|png|gif|webp|avif)$/i.test(value)) return 'filename';
  const repeats = allAlts.filter((item) => item.trim() === value).length;
  if (repeats >= 3) return 'repeated';
  return null;
}
