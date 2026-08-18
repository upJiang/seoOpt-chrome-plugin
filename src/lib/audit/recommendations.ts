import type {
  AuditCategory,
  AuditFinding,
  AuditPriority,
  AuditReport,
  TechnologyStack,
} from './types';
import type { InternationalProjectSettings, OverseasDiagnosticFinding } from '../projects/types';
import { buildOverseasDiagnosis } from '../overseas/diagnostics';

export type RecommendationCategory =
  | 'access_indexing'
  | 'content_intent'
  | 'links_media_schema'
  | 'performance_resources'
  | 'international'
  | 'tracking'
  | 'sem';

export type ModificationLayer =
  | '页面内容'
  | 'HTML 模板'
  | 'React/Vue 组件'
  | '服务端渲染'
  | '路由'
  | 'Web 服务器'
  | 'CDN'
  | 'CMS'
  | '分析追踪配置'
  | '广告数据口径';

export interface RecommendationEvidence {
  findingId: string;
  ruleId: string;
  summary: string;
  source: AuditFinding['evidenceSource'];
  confidence: AuditFinding['confidence'];
  affectedUrls: string[];
}

export interface RecommendationStrategy {
  summary: string;
  modificationLayer: ModificationLayer;
  resolves: string[];
}

export interface CodePlaceholder {
  token: string;
  meaning: string;
  required: boolean;
}

export interface CodeLineExplanation {
  code: string;
  explanation: string;
}

export interface CodeVariant {
  id: string;
  label: string;
  technology: TechnologyStack | 'generic';
  confidence: AuditFinding['confidence'];
  language: 'html' | 'css' | 'javascript' | 'typescript' | 'json' | 'nginx' | 'apache' | 'text';
  code: string | null;
}

export interface ImplementationRecipe {
  id: string;
  title: string;
  applicableTechnology: string;
  modificationLocation: string;
  prerequisites: string[];
  variant: CodeVariant;
  placeholders: CodePlaceholder[];
  lineExplanations: CodeLineExplanation[];
  prePublishChecks: string[];
  verificationSteps: string[];
  rollback: string;
}

export interface RecommendationVerification {
  codeCorrectness: string[];
  searchEffect: string[];
  successCriteria: string[];
}

export interface OptimizationRecommendation {
  id: string;
  rootCauseId: string;
  title: string;
  category: RecommendationCategory;
  priority: AuditPriority;
  confidence: AuditFinding['confidence'];
  scope: AuditFinding['scope'];
  affectedUrls: string[];
  conclusion: string;
  evidence: RecommendationEvidence[];
  seoMechanism: string;
  currentImpact: string;
  strategy: RecommendationStrategy;
  expectedDirectResult: string;
  possibleSearchEffect: string;
  notGuaranteed: string;
  implementationRecipes: ImplementationRecipe[];
  verification: RecommendationVerification;
  pitfalls: string[];
  limitations: string[];
  findings: AuditFinding[];
  effort: AuditFinding['effort'];
  owner: AuditFinding['owner'];
}

// Backward-compatible shapes are kept for existing exports and stored reports. New UI uses
// OptimizationRecommendation and does not expose these as an execution queue.
export type RecommendationSectionId = 'urgent' | 'quick_wins' | 'planned' | 'watch';
export interface RecommendationSection { id: RecommendationSectionId; title: string; description: string; findings: AuditFinding[] }
export interface RootCauseRecommendation { id: string; title: string; priority: AuditPriority; findings: AuditFinding[]; affectedUrls: string[] }
export interface FindingCodeAdvice { label: string; language: CodeVariant['language']; code: string | null; note: string }

const PRIORITY_ORDER: Record<AuditPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const CONFIDENCE_ORDER: Record<AuditFinding['confidence'], number> = { high: 0, medium: 1, low: 2 };
const EFFORT_ORDER: Record<AuditFinding['effort'], number> = { 低: 0, 中: 1, 高: 2 };

const RULE_EFFECTS: Record<string, { direct: string; search: string; limit: string }> = {
  'discoverability.response': {
    direct: '公开请求会得到与页面用途相符的状态码、最终地址和正文。',
    search: '减少抓取失败、错误地址长期保留或有效页面被当成错误页的风险。',
    limit: '状态码正确不能保证页面被收录或获得排名。',
  },
  'discoverability.index-directives': {
    direct: '最终 HTML 和响应头只表达一套与页面用途一致的索引指令。',
    search: '减少公开页面被意外排除，或内部页面意外出现在搜索结果中的风险。',
    limit: '允许索引只代表没有主动禁止，不等于搜索引擎一定收录。',
  },
  'discoverability.robots': {
    direct: '目标爬虫可以读取应公开的页面与必要渲染资源。',
    search: '减少因抓取规则误伤而无法读取正文、Canonical 或索引指令的风险。',
    limit: 'robots.txt 允许抓取不等于页面已收录，也不能代替 noindex。',
  },
  'discoverability.canonical': {
    direct: '页面最终只输出一个可访问、绝对且符合内容关系的首选网址（Canonical）。',
    search: '减少重复地址之间的版本和链接信号冲突。',
    limit: '仅添加 Canonical 不能保证搜索引擎采用该地址、收录页面或提升排名。',
  },
  'discoverability.raw-render': {
    direct: '标题、主要正文、Canonical 和关键内链在原始 HTML 中即可读取。',
    search: '降低脚本失败或渲染排队导致搜索系统延迟理解页面的风险。',
    limit: '服务端渲染不是排名保证，仍需保证内容质量和真实可用性。',
  },
  'metadata.title': {
    direct: '页面输出一个能够说明主题、对象和价值的唯一 Title。',
    search: '搜索结果标题更容易与相关查询和用户判断保持一致。',
    limit: '搜索引擎可能重写标题；Title 不是固定排名保证。',
  },
  'metadata.title-risk': {
    direct: '标题模板避免截断风险和无意义重复，同时保留页面独有信息。',
    search: '搜索摘要可能更清楚，用户更容易区分不同页面。',
    limit: '不存在适用于所有查询的固定标题长度，搜索引擎也可能重写标题。',
  },
  'metadata.description': {
    direct: '页面提供一段与当前内容一致的搜索摘要候选。',
    search: '相关查询下的搜索摘要可能更清楚，点击意愿可能改善。',
    limit: 'Google 可能重写 Description；Description 不是直接排名保证。',
  },
  'metadata.description-risk': {
    direct: '摘要模板保留页面独有价值，不因过短、过长或重复而失去辨识度。',
    search: '搜索用户可能更快判断页面是否适合自己。',
    limit: '固定字符数不能保证展示，实际摘要由查询和搜索系统共同决定。',
  },
  'metadata.h1': {
    direct: '页面拥有一个清楚表达主任务的 H1，并与后续标题形成可读结构。',
    search: '搜索系统和用户更容易判断页面核心内容及层级。',
    limit: 'H1 数量本身不是排名开关，多 H1 也不必机械删除。',
  },
  'metadata.query-alignment': {
    direct: 'Title、H1、首屏承诺和页面实际任务表达同一个用户需求。',
    search: '相关查询的展示、点击和到站后的任务完成可能更一致。',
    limit: '这不是关键词密度规则，也不能靠重复查询词保证排名。',
  },
  'content.visible-content': {
    direct: '页面补齐完成当前任务所需的结论、条件、证据和限制。',
    search: '页面可能更有能力满足相关查询，而不是只提供空泛入口。',
    limit: '没有通用最低字数，增加文字不等于增加价值或排名。',
  },
  'content.entity-signals': {
    direct: '用户可以核实内容由谁负责、何时发布或更新，以及适用范围。',
    search: '页面的责任主体与时效证据更清楚。',
    limit: '作者或日期标记不是排名保证，不得创建虚假身份或更新时间。',
  },
  'media.image-alt': {
    direct: '有信息作用的图片获得准确替代文本，装饰图保持空 Alt。',
    search: '改善无障碍读取，并帮助搜索系统理解图片在当前语境中的作用。',
    limit: 'Alt 不是关键词容器，也不能保证图片搜索排名。',
  },
  'media.json-ld': {
    direct: '结构化数据语法有效，且字段与页面可见事实一致。',
    search: '符合资格时可减少机器理解歧义并支持富结果判断。',
    limit: '有效 Schema 不保证展示富结果，更不能填写虚假评分、价格或库存。',
  },
  'performance.lcp': {
    direct: '首屏主资源更早开始下载，页面主要内容更快出现。',
    search: '可能改善移动端等待体验并减少部分转化流失。',
    limit: '本次浏览器样本不能代替真实用户 Core Web Vitals 数据。',
  },
  'performance.cls': {
    direct: '图片、广告和异步区域预留稳定空间，页面减少意外跳动。',
    search: '用户更容易阅读和点击，真实体验可能改善。',
    limit: '单次 CLS 样本不能代表全部设备和访问场景。',
  },
  'performance.fcp': {
    direct: '首屏必要样式、字体和内容更早可见。',
    search: '慢网络下的等待感可能降低。',
    limit: 'FCP 改善不代表主要内容、交互或转化一定同步改善。',
  },
  'performance.ttfb': {
    direct: '服务器更早开始返回页面响应。',
    search: '用户和抓取请求的等待可能缩短。',
    limit: '本次 TTFB 受网络、缓存和地区影响，不能代替字段数据。',
  },
  'technical.transport': {
    direct: 'HTTP、HTTPS、www 与非 www 入口收敛到同一个正式 HTTPS 地址。',
    search: '减少多入口并存造成的链接、缓存和规范版本信号分散。',
    limit: 'SEO 不要求必须使用 www；入口统一也不能保证收录或排名。',
  },
  'technical.compression': {
    direct: '适合压缩的文本响应使用 Brotli 或 gzip，减少传输字节。',
    search: '慢网络下的加载等待可能缩短。',
    limit: '开启 gzip 本身不是排名因素，也不应重复压缩图片、视频和 WOFF2。',
  },
  'technical.cache': {
    direct: '版本化静态资源可长期复用，HTML 和敏感响应按更新与隐私正确验证。',
    search: '回访加载可能更快，并减少用户长期看到旧文件的风险。',
    limit: '插件不知道真实发布频率和 CDN 回源策略，部分缓存建议需要开发确认。',
  },
  'technical.resources': {
    direct: '阻塞脚本、重复引用和非关键资源按依赖关系调整加载时序。',
    search: '首屏内容可能更早出现，主线程阻塞可能减少。',
    limit: '没有 Coverage 和源码依赖证据时不能据此直接删除文件。',
  },
  'technical.crawler-access': {
    direct: '匿名公开请求获得正确状态和包含关键内容的原始 HTML。',
    search: '降低搜索系统因访问策略或纯客户端交付而读取不稳定的风险。',
    limit: '匿名 GET 不是 Googlebot 身份验证，不能证明实际抓取或索引。',
  },
};

const GENERIC_EFFECTS: Record<AuditCategory, { direct: string; search: string; limit: string }> = {
  discoverability: { direct: '页面访问、抓取与索引信号变得一致。', search: '减少搜索系统读取和选择页面版本时的歧义。', limit: '技术信号正确后，仍需用搜索平台数据确认实际收录与排名。' },
  metadata: { direct: '页面主题和搜索摘要候选表达得更清楚。', search: '相关查询下的理解和点击判断可能改善。', limit: '搜索系统可能重写摘要，元信息不构成排名保证。' },
  content: { direct: '页面结构和任务信息更完整。', search: '页面满足相关需求的能力可能提高。', limit: '内容长度和关键词重复不能保证排名。' },
  links: { direct: '用户和搜索系统获得更清晰的页面关系与到达路径。', search: '重要页面可能更容易被发现和理解。', limit: '增加链接数量不能保证排名，链接必须真实有用。' },
  media: { direct: '媒体语义、可访问性或结构化事实更准确。', search: '图片和实体信息可能更容易被正确理解。', limit: 'Alt 或 Schema 不是排名和富结果保证。' },
  performance: { direct: '当前页面的加载或布局体验得到针对性改善。', search: '真实用户等待和交互流失可能降低。', limit: '单次访问样本不能代替字段数据或业务结果。' },
};

const BASE_CODE: Record<string, Omit<FindingCodeAdvice, 'note'>> = {
  'discoverability.response': { label: 'Nginx 路由目标', language: 'nginx', code: "location /current-path {\n  try_files $uri $uri/ =404;\n}\n\nlocation = /old-path {\n  return 301 /current-path;\n}" },
  'discoverability.index-directives': { label: '最终 HTML', language: 'html', code: '<meta name="robots" content="index,follow">' },
  'discoverability.robots': { label: 'robots.txt', language: 'text', code: 'User-agent: *\nAllow: /\nDisallow: /account/\nDisallow: /internal-search/\n\nSitemap: {{ORIGIN}}/sitemap.xml' },
  'discoverability.canonical': { label: '最终 HTML', language: 'html', code: '<link rel="canonical" href="{{PAGE_URL}}">' },
  'discoverability.raw-render': { label: '原始 HTML 目标', language: 'html', code: '<head>\n  <title>{{PAGE_TITLE}}</title>\n  <meta name="description" content="{{PAGE_DESCRIPTION}}">\n  <link rel="canonical" href="{{PAGE_URL}}">\n</head>\n<body>\n  <main><h1>{{PAGE_H1}}</h1></main>\n</body>' },
  'metadata.title': { label: '最终 HTML', language: 'html', code: '<title>{{PAGE_TITLE}}</title>' },
  'metadata.title-risk': { label: '标题模板目标', language: 'html', code: '<title>{{CORE_TOPIC}} - {{AUDIENCE_OR_VALUE}} | {{BRAND}}</title>' },
  'metadata.description': { label: '最终 HTML', language: 'html', code: '<meta name="description" content="{{PAGE_DESCRIPTION}}">' },
  'metadata.description-risk': { label: '摘要模板目标', language: 'html', code: '<meta name="description" content="{{AUDIENCE}}可在本页{{PAGE_TASK}}，并了解{{DIFFERENCE}}。">' },
  'metadata.h1': { label: '最终 HTML', language: 'html', code: '<main>\n  <h1>{{PAGE_H1}}</h1>\n  <section>\n    <h2>{{SUPPORTING_QUESTION}}</h2>\n  </section>\n</main>' },
  'metadata.query-alignment': { label: '页面承诺结构', language: 'html', code: '<title>{{USER_NEED}} - {{AUDIENCE_OR_VALUE}}</title>\n<h1>{{NATURAL_USER_NEED}}</h1>\n<p>{{DIRECT_ANSWER_AND_EVIDENCE}}</p>' },
  'content.heading-order': { label: '标题结构', language: 'html', code: '<h1>{{PAGE_TASK}}</h1>\n<section>\n  <h2>{{MAIN_QUESTION}}</h2>\n  <h3>{{DETAIL_UNDER_QUESTION}}</h3>\n</section>' },
  'content.main-landmark': { label: '页面地标', language: 'html', code: '<header>{{SITE_NAVIGATION}}</header>\n<main id="main-content">{{PRIMARY_CONTENT}}</main>\n<footer>{{SITE_FOOTER}}</footer>' },
  'content.language': { label: '文档语言', language: 'html', code: '<html lang="{{BCP47_LANGUAGE}}">' },
  'content.entity-signals': { label: '文章责任信息', language: 'html', code: '<article>\n  <h1>{{ARTICLE_TITLE}}</h1>\n  <p>作者：<a rel="author" href="{{AUTHOR_URL}}">{{REAL_AUTHOR}}</a></p>\n  <time datetime="{{ISO_DATE}}">{{VISIBLE_DATE}}</time>\n</article>' },
  'links.valid-hrefs': { label: '链接与按钮', language: 'html', code: '<a href="/services/seo-audit">查看 SEO 审计服务</a>\n<button type="button" aria-controls="filters">打开筛选</button>' },
  'links.anchor-text': { label: '可理解链接', language: 'html', code: '<a href="/guides/technical-seo">阅读技术 SEO 排查指南</a>' },
  'links.internal-entry': { label: '相关内容入口', language: 'html', code: '<nav aria-label="相关内容">\n  <a href="{{RELATED_URL}}">{{NATURAL_ANCHOR_TEXT}}</a>\n</nav>' },
  'links.fragments': { label: '页内目录', language: 'html', code: '<nav aria-label="本文目录"><a href="#audit-details">审计详情</a></nav>\n<section id="audit-details" tabindex="-1"><h2>审计详情</h2></section>' },
  'links.pagination': { label: '可抓取分页', language: 'html', code: '<nav aria-label="分页">\n  <a href="?page={{PREVIOUS_PAGE}}">上一页</a>\n  <a href="?page={{NEXT_PAGE}}">下一页</a>\n</nav>' },
  'media.image-alt': { label: '图片替代文本', language: 'html', code: '<img src="{{IMAGE_URL}}" alt="{{IMAGE_MEANING_IN_CONTEXT}}">\n<img src="/divider.svg" alt="" role="presentation">' },
  'media.image-dimensions': { label: '稳定图片尺寸', language: 'html', code: '<img src="{{IMAGE_URL}}" width="960" height="540" alt="{{IMAGE_ALT}}">' },
  'media.loading-priority': { label: '首屏图片优先级', language: 'html', code: '<link rel="preload" as="image" href="{{HERO_IMAGE}}" fetchpriority="high">\n<img src="{{HERO_IMAGE}}" width="1280" height="720" fetchpriority="high" alt="{{HERO_ALT}}">' },
  'media.json-ld': { label: '只含已确认事实的 JSON-LD', language: 'json', code: '<script type="application/ld+json">\n{\n  "@context": "https://schema.org",\n  "@type": "WebPage",\n  "name": "{{VISIBLE_PAGE_NAME}}",\n  "url": "{{PAGE_URL}}"\n}\n</script>' },
  'performance.lcp': { label: '首屏主图加载', language: 'html', code: '<link rel="preload" as="image" href="{{HERO_IMAGE}}" fetchpriority="high">\n<img src="{{HERO_IMAGE}}" width="1280" height="720" fetchpriority="high" alt="{{HERO_ALT}}">' },
  'performance.cls': { label: '稳定布局', language: 'css', code: '.hero-media { aspect-ratio: 16 / 9; }\n.hero-media img { width: 100%; height: 100%; object-fit: cover; }' },
  'performance.fcp': { label: '关键资源加载', language: 'html', code: '<style>/* 仅放首屏必要样式 */</style>\n<script src="/non-critical.js" defer></script>' },
  'performance.ttfb': { label: '静态资源缓存', language: 'nginx', code: 'location /assets/ {\n  expires 30d;\n  add_header Cache-Control "public, max-age=2592000, immutable";\n}' },
  'performance.viewport': { label: '移动端视口', language: 'html', code: '<meta name="viewport" content="width=device-width, initial-scale=1">' },
  'technical.transport': { label: 'Nginx 正式入口', language: 'nginx', code: 'server {\n  listen 80;\n  server_name {{HOST}} www.{{HOST}};\n  return 301 https://{{PREFERRED_HOST}}$request_uri;\n}' },
  'technical.compression': { label: 'Nginx 文本压缩', language: 'nginx', code: 'gzip on;\ngzip_vary on;\ngzip_types text/css application/javascript application/json application/xml image/svg+xml;' },
  'technical.cache': { label: 'Nginx 分类缓存', language: 'nginx', code: 'location /assets/ {\n  expires 1y;\n  add_header Cache-Control "public, max-age=31536000, immutable";\n}\nlocation / {\n  add_header Cache-Control "no-cache";\n}' },
  'technical.resources': { label: '脚本加载策略', language: 'html', code: '<script src="/navigation.js" defer></script>\n<script src="/independent-analytics.js" async></script>' },
  'technical.crawler-access': { label: '原始 HTML 内容目标', language: 'html', code: '<main>\n  <h1>{{PAGE_H1}}</h1>\n  <p>{{PRIMARY_CONTENT_SUMMARY}}</p>\n</main>' },
  'links.nofollow-policy': { label: '链接关系', language: 'html', code: '<a href="/guide">正常内部链接</a>\n<a href="https://partner.example" rel="sponsored nofollow">付费合作</a>\n<a href="https://user.example" rel="ugc nofollow">用户内容</a>' },
};

function cleanPageUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|gclid|dclid|gbraid|wbraid|msclkid|fbclid|yclid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return value;
  }
}

function interpolate(code: string, report?: AuditReport): string {
  if (!report) return code;
  const pageUrl = cleanPageUrl(report.snapshot.siteProbe.page.finalUrl || report.url);
  const parsed = new URL(pageUrl);
  const title = report.snapshot.titleTags.find((item) => item.trim()) || '当前页面标题';
  const description = report.snapshot.descriptions.find((item) => item.trim()) || '请填写与当前页面可见内容一致的摘要';
  const h1 = report.snapshot.headings.find((item) => item.level === 1)?.text || '当前页面主标题';
  return code
    .replace(/\{\{ORIGIN\}\}/g, parsed.origin)
    .replace(/\{\{PAGE_URL\}\}/g, pageUrl)
    .replace(/\{\{HOST\}\}/g, parsed.hostname.replace(/^www\./, ''))
    .replace(/\{\{PREFERRED_HOST\}\}/g, parsed.hostname)
    .replace(/\{\{PAGE_TITLE\}\}/g, title)
    .replace(/\{\{PAGE_DESCRIPTION\}\}/g, description)
    .replace(/\{\{PAGE_H1\}\}/g, h1)
    .replace('/current-path', parsed.pathname || '/');
}

export function getFindingCodeAdvice(finding: AuditFinding, report?: AuditReport): FindingCodeAdvice {
  const configured = BASE_CODE[finding.ruleId];
  if (configured) return {
    ...configured,
    label: finding.ruleId === 'links.valid-hrefs' ? '通用 HTML 示例' : configured.label,
    code: configured.code ? interpolate(configured.code, report) : null,
    note: '先确认修改层、实际框架和技术栈；代码只复制代码本身。发布后应检查最终 HTML、响应头或页面行为，而不是只检查源文件。',
  };
  if (finding.codeExample) return {
    label: '规则提供的实现目标',
    language: 'html',
    code: interpolate(finding.codeExample, report),
    note: '当前证据不足以确认具体框架；请把示例改写到真实模板，并验证最终输出。',
  };
  return {
    label: '内容或数据策略',
    language: 'text',
    code: null,
    note: '这项不能仅靠一段前端代码可靠修复。请调整内容结构、业务口径或平台配置，再用对应证据验证。',
  };
}

function recommendationCategory(finding: AuditFinding): RecommendationCategory {
  if (finding.category === 'discoverability') return 'access_indexing';
  if (finding.category === 'metadata' || finding.category === 'content') return 'content_intent';
  if (finding.category === 'performance') return 'performance_resources';
  return 'links_media_schema';
}

function modificationLayer(finding: AuditFinding): ModificationLayer {
  if (/transport|compression|cache/.test(finding.ruleId)) return 'Web 服务器';
  if (/response/.test(finding.ruleId)) return '路由';
  if (/robots/.test(finding.ruleId)) return 'Web 服务器';
  if (/raw-render|crawler-access/.test(finding.ruleId)) return '服务端渲染';
  if (/visible-content|entity-signals|query-alignment/.test(finding.ruleId)) return '页面内容';
  if (/metadata|canonical|h1|language|json-ld|image|links|nofollow|resources|viewport|performance/.test(finding.ruleId)) return 'HTML 模板';
  return finding.owner === '内容' ? '页面内容' : 'HTML 模板';
}

function placeholdersFor(code: string | null): CodePlaceholder[] {
  if (!code) return [];
  const explicit = [...code.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((match) => match[0]);
  const providerTokens = [...code.matchAll(/\b(?:G|AW)-X{4,}(?:\/label)?\b/g)].map((match) => match[0]);
  return [...new Set([...explicit, ...providerTokens])].map((token) => ({
    token,
    meaning: ({
      '{{CORE_TOPIC}}': '当前页面独有的核心主题',
      '{{AUDIENCE_OR_VALUE}}': '适用对象、场景或可验证价值',
      '{{BRAND}}': '真实品牌简称',
      '{{PAGE_TASK}}': '用户在当前页面能完成的主要任务',
      '{{PAGE_URL}}': '当前页面去除广告追踪参数和 fragment 后的最终 HTTPS 地址',
      '{{CURRENT_LANGUAGE}}': '当前页面正文与 html lang 已确认一致的 BCP 47 语言代码',
      '{{ALTERNATE_LANGUAGE}}': '确实存在的对应语言页语言代码，例如 en-US；没有对应页面时不要输出',
      '{{ALTERNATE_PAGE_URL}}': '确实存在且可访问的对应语言页 HTTPS 绝对地址；不能凭空创建',
      '{{BCP47_LANGUAGE}}': '与正文一致的 BCP 47 语言代码，例如 en 或 zh-CN',
      '{{HERO_IMAGE}}': '本页真实首屏主图地址',
      'G-XXXXXXX': 'GA4 数据流中的真实 Measurement ID；不能照抄示例值',
      'AW-XXXXXXX/label': 'Google Ads 真实转化 ID 与转化标签；必须来自对应转化操作',
    } as Record<string, string>)[token] || '必须替换为当前页面或模板中的真实值',
    required: true,
  }));
}

function overseasCategory(finding: OverseasDiagnosticFinding): RecommendationCategory {
  return finding.category === 'international'
    ? 'international'
    : finding.category === 'search_access'
      ? 'access_indexing'
      : 'tracking';
}

function overseasCodeLanguage(code: string): CodeVariant['language'] {
  if (/^\s*</.test(code)) return 'html';
  if (/gtag|uetq|\bconst\b|\bwindow\b|\/\//.test(code)) return 'javascript';
  return 'text';
}

function overseasRecommendation(
  finding: OverseasDiagnosticFinding,
  report: AuditReport,
): OptimizationRecommendation {
  const category = overseasCategory(finding);
  const isBusinessLocalization = finding.area === 'business_localization';
  const recommendationLayer: ModificationLayer = isBusinessLocalization
    ? '页面内容'
    : category === 'international' ? 'HTML 模板' : '分析追踪配置';
  const rootCauseId = finding.id;
  const currentLanguage = report.snapshot.overseas?.internationalSeo.htmlLang || '{{CURRENT_LANGUAGE}}';
  const auditFinding: AuditFinding = {
    id: rootCauseId,
    ruleId: rootCauseId,
    category: category === 'international' ? 'content' : 'metadata',
    title: finding.title,
    status: finding.kind === 'issue' ? 'failure' : 'warning',
    priority: finding.priority,
    points: 0,
    scoreRatio: null,
    includedInScore: false,
    evidence: finding.evidence,
    impact: finding.why,
    explanation: finding.why,
    recommendation: finding.action,
    verification: finding.verification,
    observationPeriod: '发布后先验证页面或事件直接结果；平台接收和业务效果使用成熟数据确认。',
    effort: '中',
    owner: '联合',
    rollback: finding.rollback,
    limitations: finding.limitation,
    scope: 'page',
    evidenceSource: finding.category === 'search_access' ? 'http_response' : 'rendered_dom',
    confidence: finding.confidence,
    rootCauseId,
    affectedUrls: [report.url],
    ...(finding.codeExample ? { codeExample: finding.codeExample } : {}),
  };
  const code = finding.codeExample
    ? interpolate(finding.codeExample, report).replace(/\{\{CURRENT_LANGUAGE\}\}/g, currentLanguage)
    : null;
  const variant: CodeVariant = {
    id: `${rootCauseId}:implementation`,
    label: category === 'international' ? '国际页面 HTML 目标' : '分析与广告追踪示例',
    technology: 'generic',
    confidence: finding.confidence,
    language: code ? overseasCodeLanguage(code) : 'text',
    code,
  };
  const recipe: ImplementationRecipe = {
    id: variant.id,
    title: variant.label,
    applicableTechnology: isBusinessLocalization ? '页面内容、CMS 页面模块或业务配置' : category === 'international' ? '最终 HTML 或国际页面模板' : 'GTM、页面追踪代码或 CMP 配置',
    modificationLocation: isBusinessLocalization
      ? '目标市场语言页面的价格、服务范围、付款、配送、税费、政策和联系信息模块'
      : category === 'international'
        ? '当前语言页面的服务端模板、元数据组件或 CMS 多语言配置'
        : 'GTM 容器、页面追踪初始化、Consent/CMP 或转化事件成功回调',
    prerequisites: isBusinessLocalization
      ? ['先确认目标国家或地区、实际服务范围、付款方式、履约时效和税费规则。', '不要在业务事实未确认前生成价格、库存或配送承诺。']
      : category === 'international'
        ? ['确认当前页面真实语言、正式 Canonical 和确实存在的对应语言页。']
        : ['确认标签 ID、主要转化定义和事件应在业务成功后的哪个回调触发。', '浏览器观察不能代替分析或广告平台后台确认。'],
    variant,
    placeholders: placeholdersFor(code),
    lineExplanations: explainCode(code, rootCauseId),
    prePublishChecks: [
      '替换示例 ID、地址和事件名，只使用网站真实配置与已确认事实。',
      '一次只调整一个安装来源或触发条件，避免同时修改后无法判断重复来源。',
    ],
    verificationSteps: [finding.verification, finding.platformConfirmation],
    rollback: finding.rollback,
  };
  return {
    id: `recommendation:${rootCauseId}`,
    rootCauseId,
    title: finding.title,
    category,
    priority: finding.priority,
    confidence: finding.confidence,
    scope: 'page',
    affectedUrls: [report.url],
    conclusion: finding.evidence,
    evidence: [{ findingId: auditFinding.id, ruleId: auditFinding.ruleId, summary: finding.evidence, source: auditFinding.evidenceSource, confidence: finding.confidence, affectedUrls: [report.url] }],
    seoMechanism: finding.why,
    currentImpact: `${finding.applicability} ${finding.why}`,
    strategy: { summary: finding.action, modificationLayer: recommendationLayer, resolves: [finding.title] },
    expectedDirectResult: finding.directResult,
    possibleSearchEffect: finding.possibleEffect,
    notGuaranteed: finding.notGuaranteed,
    implementationRecipes: [recipe],
    verification: {
      codeCorrectness: [finding.verification],
      searchEffect: [finding.platformConfirmation],
      successCriteria: [isBusinessLocalization ? '目标市场用户可以在页面上确认服务范围、费用、付款和联系路径。' : category === 'international' ? '页面及对应语言页不再出现相同冲突。' : '同一次成功业务只记录一次，失败业务不被记为主要转化。'],
    },
    pitfalls: [isBusinessLocalization ? '不要把未确认的价格、税费、库存或配送承诺写进页面；先由业务负责人确认。' : category === 'international' ? '不要创建并不存在的语言页，也不要让所有语言页 Canonical 到同一个地区版本。' : '不要把标签存在当成后台接收或有效业务，也不要照抄示例标签 ID。'],
    limitations: [finding.limitation],
    findings: [auditFinding],
    effort: '中',
    owner: '联合',
  };
}

function explainCode(code: string | null, ruleId: string): CodeLineExplanation[] {
  if (!code) return [];
  const explanations: CodeLineExplanation[] = [];
  if (code.includes('rel="canonical"')) explanations.push({ code: 'rel="canonical"', explanation: '声明当前内容的首选地址；每个页面要动态输出自己的版本。' });
  if (code.includes('href=')) explanations.push({ code: 'href', explanation: '使用最终可访问的 HTTPS 绝对地址；不要让所有页面固定指向首页。' });
  if (code.includes('<title>')) explanations.push({ code: '<title>', explanation: '浏览器标题和搜索结果标题候选；应由页面真实主题动态生成。' });
  if (code.includes('name="description"')) explanations.push({ code: 'content', explanation: '摘要候选必须与页面可见内容一致，不能写页面没有提供的承诺。' });
  if (code.includes('name="robots"')) explanations.push({ code: 'index,follow / noindex,follow', explanation: 'index/noindex 控制是否允许索引；follow 表示不额外限制页面链接关系。' });
  if (code.includes('return 301')) explanations.push({ code: 'return 301', explanation: '永久跳转到唯一正式地址，并保留原请求路径和参数。' });
  if (code.includes('gzip')) explanations.push({ code: 'gzip_types', explanation: '只列适合压缩的文本类型，不包含图片、视频和已压缩字体。' });
  if (code.includes('immutable')) explanations.push({ code: 'immutable', explanation: '仅适用于文件名带稳定版本指纹、内容变化会换 URL 的静态资源。' });
  if (code.includes('defer')) explanations.push({ code: 'defer', explanation: '脚本可并行下载，并在 HTML 解析完成后按顺序执行。' });
  if (code.includes('async')) explanations.push({ code: 'async', explanation: '只用于不依赖 DOM 顺序和其他脚本的独立脚本。' });
  if (code.includes('application/ld+json')) explanations.push({ code: 'application/ld+json', explanation: '承载机器可读事实；只填写页面已确认且可见或可验证的数据。' });
  if (!explanations.length) explanations.push({ code: ruleId, explanation: '这段代码表达最终页面应达到的结构；请在真实模板或组件中动态生成。' });
  return explanations;
}

function frameworkVariant(stack: TechnologyStack, finding: AuditFinding, report: AuditReport): CodeVariant | null {
  const url = cleanPageUrl(report.url);
  const title = report.snapshot.titleTags.find((item) => item.trim()) || '当前页面标题';
  const description = report.snapshot.descriptions.find((item) => item.trim()) || '与当前页面可见内容一致的摘要';
  if (!/^metadata\.(title|description)|discoverability\.canonical$/.test(finding.ruleId)) return null;
  if (stack === 'nextjs') return {
    id: `${finding.rootCauseId}:nextjs`, label: 'Next.js App Router', technology: stack, confidence: report.snapshot.technology?.confidence || 'low', language: 'typescript',
    code: `// app/对应路由/page.tsx\nimport type { Metadata } from 'next';\n\nexport const metadata: Metadata = {\n  title: ${JSON.stringify(title)},\n  description: ${JSON.stringify(description)},\n  alternates: { canonical: ${JSON.stringify(url)} },\n};`,
  };
  if (stack === 'nuxt' || stack === 'vue') return {
    id: `${finding.rootCauseId}:nuxt`, label: 'Nuxt / Vue SSR', technology: stack, confidence: report.snapshot.technology?.confidence || 'low', language: 'typescript',
    code: `<script setup lang="ts">\nuseSeoMeta({\n  title: ${JSON.stringify(title)},\n  description: ${JSON.stringify(description)},\n});\nuseHead({ link: [{ rel: 'canonical', href: ${JSON.stringify(url)} }] });\n</script>`,
  };
  if (stack === 'react') return {
    id: `${finding.rootCauseId}:react`, label: 'React SPA（需确认渲染方式）', technology: stack, confidence: report.snapshot.technology?.confidence || 'low', language: 'typescript',
    code: `// 在当前路由组件中输出；公开获客页优先配合 SSR/预渲染\n<Helmet>\n  <title>${title}</title>\n  <meta name="description" content=${JSON.stringify(description)} />\n  <link rel="canonical" href=${JSON.stringify(url)} />\n</Helmet>`,
  };
  if (stack === 'wordpress') return {
    id: `${finding.rootCauseId}:wordpress`, label: 'WordPress', technology: stack, confidence: report.snapshot.technology?.confidence || 'low', language: 'text',
    code: '优先在当前主题的 SEO 插件或模板元数据设置中配置；不要同时由主题、插件和自定义代码重复输出。',
  };
  if (stack === 'shopify') return {
    id: `${finding.rootCauseId}:shopify`, label: 'Shopify Liquid', technology: stack, confidence: report.snapshot.technology?.confidence || 'low', language: 'html',
    code: `<title>{{ page_title | escape }}</title>\n<meta name="description" content="{{ page_description | escape }}">\n<link rel="canonical" href="{{ canonical_url }}">`,
  };
  return null;
}

function recipeFromVariant(finding: AuditFinding, variant: CodeVariant, layer: ModificationLayer): ImplementationRecipe {
  return {
    id: variant.id,
    title: variant.label,
    applicableTechnology: variant.technology === 'generic' ? '最终 HTML 或通用模板' : variant.label,
    modificationLocation: layer === 'Web 服务器' ? '站点 server/location 配置块或对应 CDN 规则' : layer === '页面内容' ? '当前页面内容模块或 CMS 字段' : '当前页面对应的路由、模板、布局或元数据组件',
    prerequisites: [
      '先确认当前页面用途、正式 URL 和索引目标。',
      variant.technology === 'generic' ? '如果无法确认框架，以最终 HTML 或响应结果作为验收目标。' : `插件对该技术栈的识别置信度为${variant.confidence === 'high' ? '高' : variant.confidence === 'medium' ? '中' : '低'}，发布前仍需在源码中确认。`,
    ],
    variant,
    placeholders: placeholdersFor(variant.code),
    lineExplanations: explainCode(variant.code, finding.ruleId),
    prePublishChecks: [
      '替换全部占位变量，且只使用页面已有或业务确认的事实。',
      '在测试环境检查重复输出、转义、路由和移动端页面。',
      ...(variant.language === 'nginx' ? ['运行 nginx -t，通过后再热加载配置。'] : []),
    ],
    verificationSteps: [finding.verification, '查看浏览器最终 DOM；涉及服务器规则时同时检查真实响应头、状态码和最终 URL。'],
    rollback: finding.rollback,
  };
}

function buildRecipes(finding: AuditFinding, report: AuditReport, layer: ModificationLayer): ImplementationRecipe[] {
  const advice = getFindingCodeAdvice(finding, report);
  const generic: CodeVariant = {
    id: `${finding.rootCauseId}:generic`, label: advice.label, technology: 'generic', confidence: 'high', language: advice.language, code: advice.code,
  };
  const recipes = [recipeFromVariant(finding, generic, layer)];
  const detected = report.snapshot.technology?.primary || 'unknown';
  const framework = frameworkVariant(detected, finding, report);
  if (framework) recipes.push(recipeFromVariant(finding, framework, layer));
  return recipes;
}

function sortFindings(findings: AuditFinding[]): AuditFinding[] {
  return [...findings].sort((left, right) => {
    const priority = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
    if (priority) return priority;
    const confidence = CONFIDENCE_ORDER[left.confidence] - CONFIDENCE_ORDER[right.confidence];
    if (confidence) return confidence;
    if (left.status !== right.status) return left.status === 'failure' ? -1 : 1;
    const urls = right.affectedUrls.length - left.affectedUrls.length;
    if (urls) return urls;
    const points = right.points - left.points;
    if (points) return points;
    return EFFORT_ORDER[left.effort] - EFFORT_ORDER[right.effort];
  });
}

export function groupRecommendationsByRootCause(findings: AuditFinding[]): RootCauseRecommendation[] {
  const groups = new Map<string, AuditFinding[]>();
  for (const finding of sortFindings(findings.filter((item) => item.status === 'failure' || item.status === 'warning'))) {
    const id = finding.rootCauseId || finding.ruleId;
    groups.set(id, [...(groups.get(id) || []), finding]);
  }
  return [...groups.entries()].map(([id, items]) => ({
    id,
    title: items[0]!.title,
    priority: items[0]!.priority,
    findings: items,
    affectedUrls: [...new Set(items.flatMap((item) => item.affectedUrls))],
  }));
}

export function buildOptimizationRecommendations(report: AuditReport): OptimizationRecommendation[] {
  const pageRecommendations = groupRecommendationsByRootCause(report.findings).map((group) => {
    const primary = group.findings[0]!;
    const effect = RULE_EFFECTS[primary.ruleId] || GENERIC_EFFECTS[primary.category];
    const layer = modificationLayer(primary);
    const evidence = group.findings.map((finding): RecommendationEvidence => ({
      findingId: finding.id,
      ruleId: finding.ruleId,
      summary: finding.evidence,
      source: finding.evidenceSource,
      confidence: finding.confidence,
      affectedUrls: finding.affectedUrls,
    }));
    const resolvedTitles = [...new Set(group.findings.map((finding) => finding.title))];
    return {
      id: `recommendation:${group.id}`,
      rootCauseId: group.id,
      title: resolvedTitles.length > 1 ? `${primary.title}等同一根因问题` : primary.title,
      category: recommendationCategory(primary),
      priority: primary.priority,
      confidence: primary.confidence,
      scope: primary.scope,
      affectedUrls: group.affectedUrls,
      conclusion: primary.evidence,
      evidence,
      seoMechanism: primary.explanation,
      currentImpact: group.findings.map((finding) => finding.impact).filter((value, index, values) => values.indexOf(value) === index).join('；'),
      strategy: { summary: primary.recommendation, modificationLayer: layer, resolves: resolvedTitles },
      expectedDirectResult: effect.direct,
      possibleSearchEffect: effect.search,
      notGuaranteed: effect.limit,
      implementationRecipes: buildRecipes(primary, report, layer),
      verification: {
        codeCorrectness: [primary.verification, '重新扫描当前页面，确认相关规则状态和最终输出已经变化。'],
        searchEffect: [primary.observationPeriod, '涉及收录、展示或点击时，只使用完整、等长且成熟的搜索数据周期比较。'],
        successCriteria: [`${resolvedTitles.join('、')}不再出现相同直接证据。`, effect.direct],
      },
      pitfalls: [primary.antiPattern || '不要为提高工具分数叠加无关修改，也不要在没有依赖证据时删除内容或资源。'],
      limitations: [primary.limitations || '当前结论来自本次页面和浏览器可取得的证据；实际收录、排名和业务效果需要外部数据验证。'],
      findings: group.findings,
      effort: primary.effort,
      owner: primary.owner,
    };
  });
  const overseasSettings: InternationalProjectSettings = {
    targetCountry: '',
    targetLanguage: report.snapshot.overseas?.internationalSeo.targetLanguage ?? '',
    searchEngine: 'both',
    useGoogleAds: false,
    useMicrosoftAds: false,
    conversionDomains: [],
  };
  const overseasDiagnosis = report.snapshot.overseas
    ? buildOverseasDiagnosis({ snapshot: report.snapshot, staticSnapshot: report.snapshot.overseas, settings: overseasSettings, expectedIndexState: report.context.expectedIndexState })
    : null;
  const overseasRecommendations = overseasDiagnosis
    ? buildOverseasOptimizationRecommendations(report, overseasDiagnosis)
    : [];
  return [...pageRecommendations, ...overseasRecommendations].sort((left, right) => {
    const priority = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
    if (priority) return priority;
    const confidence = CONFIDENCE_ORDER[left.confidence] - CONFIDENCE_ORDER[right.confidence];
    if (confidence) return confidence;
    const urls = right.affectedUrls.length - left.affectedUrls.length;
    if (urls) return urls;
    return EFFORT_ORDER[left.effort] - EFFORT_ORDER[right.effort];
  });
}

export function buildOverseasOptimizationRecommendations(
  report: AuditReport,
  diagnosis: import('../projects/types').OverseasDiagnosis,
): OptimizationRecommendation[] {
  return [...diagnosis.issues, ...diagnosis.opportunities]
    .map((finding) => overseasRecommendation(finding, report))
    .sort((left, right) => {
      const kindOrder = Number(left.findings[0]?.status !== 'failure') - Number(right.findings[0]?.status !== 'failure');
      if (kindOrder) return kindOrder;
      const priority = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
      if (priority) return priority;
      const confidence = CONFIDENCE_ORDER[left.confidence] - CONFIDENCE_ORDER[right.confidence];
      if (confidence) return confidence;
      return EFFORT_ORDER[left.effort] - EFFORT_ORDER[right.effort];
    });
}

export function getExpectedOutcome(finding: AuditFinding): string {
  const effect = RULE_EFFECTS[finding.ruleId] || GENERIC_EFFECTS[finding.category];
  return `${effect.direct} ${effect.search} ${effect.limit}`;
}

export function buildRecommendationSections(findings: AuditFinding[]): RecommendationSection[] {
  const actionable = sortFindings(findings.filter((finding) => finding.status === 'failure' || finding.status === 'warning'));
  return [
    { id: 'urgent', title: '已确认的高影响问题', description: '直接证据支持的阻断或高影响问题。', findings: actionable.filter((finding) => finding.priority === 'P0' || finding.priority === 'P1') },
    { id: 'quick_wins', title: '高置信度增长问题', description: '证据明确且修改成本较低的增长项。', findings: actionable.filter((finding) => finding.priority === 'P2' && finding.effort === '低') },
    { id: 'planned', title: '需要完整实现的增长问题', description: '需要模板、内容或开发协同的增长项。', findings: actionable.filter((finding) => finding.priority === 'P2' && finding.effort !== '低') },
    { id: 'watch', title: '风险候选与外部数据缺口', description: '保留限制，等待更多证据确认。', findings: actionable.filter((finding) => finding.priority === 'P3') },
  ];
}
