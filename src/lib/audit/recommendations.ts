import type { AuditCategory, AuditFinding, AuditPriority } from './types';

export type RecommendationSectionId = 'urgent' | 'quick_wins' | 'planned' | 'watch';

export interface RecommendationSection {
  id: RecommendationSectionId;
  title: string;
  description: string;
  findings: AuditFinding[];
}

export interface RootCauseRecommendation {
  id: string;
  title: string;
  priority: AuditPriority;
  findings: AuditFinding[];
  affectedUrls: string[];
}

export interface FindingCodeAdvice {
  label: string;
  language: 'html' | 'css' | 'javascript' | 'json' | 'nginx' | 'text';
  code: string | null;
  note: string;
}

const CODE_ADVICE: Record<string, Omit<FindingCodeAdvice, 'note'>> = {
  'discoverability.response': {
    label: '服务器路由示例', language: 'nginx',
    code: 'location /expected-path {\n  try_files $uri $uri/ =404;\n}\n\n# 永久迁移时只跳转到最终规范地址\nlocation = /old-path {\n  return 301 /new-path;\n}',
  },
  'discoverability.index-directives': {
    label: '通用 HTML 示例', language: 'html',
    code: '<!-- 公开页面 -->\n<meta name="robots" content="index,follow">\n\n<!-- 明确不需要搜索展示的页面 -->\n<meta name="robots" content="noindex,follow">',
  },
  'discoverability.robots': {
    label: 'robots.txt 示例', language: 'text',
    code: 'User-agent: *\nAllow: /\nDisallow: /account/\nDisallow: /internal-search/\n\nSitemap: https://example.com/sitemap.xml',
  },
  'discoverability.canonical': {
    label: '通用 HTML 示例', language: 'html',
    code: '<link rel="canonical" href="https://example.com/preferred-path">',
  },
  'discoverability.raw-render': {
    label: '服务端输出示例', language: 'html',
    code: '<head>\n  <title>服务端即可读取的页面标题</title>\n  <meta name="description" content="服务端输出的页面摘要">\n  <link rel="canonical" href="https://example.com/page">\n</head>\n<body>\n  <main><h1>服务端即可读取的主标题</h1></main>\n</body>',
  },
  'metadata.title': { label: '通用 HTML 示例', language: 'html', code: '<title>核心主题 - 适用对象与明确价值</title>' },
  'metadata.title-risk': { label: '模板写法示例', language: 'html', code: '<title>{{核心主题}} - {{对象或场景}} | {{短品牌名}}</title>' },
  'metadata.description': { label: '通用 HTML 示例', language: 'html', code: '<meta name="description" content="说明页面解决什么问题、适合谁，以及用户下一步能获得什么。">' },
  'metadata.description-risk': { label: '模板写法示例', language: 'html', code: '<meta name="description" content="{{适用对象}}可在本页完成{{页面任务}}，了解{{关键差异}}与{{下一步行动}}。">' },
  'metadata.h1': { label: '通用 HTML 示例', language: 'html', code: '<main>\n  <h1>当前页面唯一的主任务</h1>\n  <h2>完成任务需要了解的第一个问题</h2>\n</main>' },
  'metadata.query-alignment': { label: '页面承诺示例', language: 'html', code: '<title>{{用户需求}} - {{适用场景与差异}}</title>\n<h1>{{自然表达的用户需求}}</h1>\n<p>{{直接回答需求，并说明下一步}}</p>' },
  'content.heading-order': { label: '通用 HTML 示例', language: 'html', code: '<h1>页面主任务</h1>\n<section>\n  <h2>主要问题</h2>\n  <h3>问题下的具体步骤</h3>\n</section>' },
  'content.main-landmark': { label: '通用 HTML 示例', language: 'html', code: '<header>全站导航</header>\n<main id="main-content">页面唯一的主要内容</main>\n<footer>全站页脚</footer>' },
  'content.language': { label: '通用 HTML 示例', language: 'html', code: '<html lang="zh-CN">' },
  'content.entity-signals': { label: '文章责任信息示例', language: 'html', code: '<article>\n  <h1>文章标题</h1>\n  <p>作者：<a rel="author" href="/authors/name">作者姓名</a></p>\n  <time datetime="2026-08-04">2026-08-04</time>\n</article>' },
  'links.valid-hrefs': { label: '通用 HTML 示例', language: 'html', code: '<!-- 页面导航使用真实地址 -->\n<a href="/services/seo-audit">查看 SEO 审计服务</a>\n\n<!-- 页面内操作使用按钮 -->\n<button type="button" aria-controls="filters">打开筛选</button>' },
  'links.anchor-text': { label: '通用 HTML 示例', language: 'html', code: '<a href="/guides/technical-seo">阅读技术 SEO 排查指南</a>\n<a href="/pricing" aria-label="查看 SEO 审计价格"><svg aria-hidden="true">...</svg></a>' },
  'links.internal-entry': { label: '正文内链示例', language: 'html', code: '<nav aria-label="相关内容">\n  <a href="/guides/keyword-research">关键词研究方法</a>\n  <a href="/services/seo-audit">下一步：申请 SEO 审计</a>\n</nav>' },
  'links.fragments': { label: '页内目录示例', language: 'html', code: '<nav aria-label="本文目录"><a href="#audit-steps">审计步骤</a></nav>\n<section id="audit-steps" tabindex="-1"><h2>审计步骤</h2></section>' },
  'links.pagination': { label: '可抓取分页示例', language: 'html', code: '<nav aria-label="分页">\n  <a href="/articles?page=1">上一页</a>\n  <a href="/articles?page=3">下一页</a>\n</nav>' },
  'media.image-alt': { label: '通用 HTML 示例', language: 'html', code: '<img src="chart.webp" alt="自然搜索点击在三个月内的变化趋势">\n<img src="divider.svg" alt="" role="presentation">' },
  'media.image-dimensions': { label: 'HTML / CSS 示例', language: 'html', code: '<img src="image.webp" width="960" height="540" alt="图片描述">\n<style>img { max-width: 100%; height: auto; }</style>' },
  'media.loading-priority': { label: '首屏图片示例', language: 'html', code: '<img src="hero.webp" width="1280" height="720" fetchpriority="high" alt="主图描述">\n<!-- 屏外图片才使用 loading="lazy" -->' },
  'media.json-ld': { label: 'JSON-LD 语法示例', language: 'json', code: '<script type="application/ld+json">\n{\n  "@context": "https://schema.org",\n  "@type": "Article",\n  "headline": "与页面可见标题一致的文章标题"\n}\n</script>' },
  'media.conditional': { label: '视频与多语言示例', language: 'html', code: '<video controls poster="/video-cover.webp">\n  <source src="/guide.mp4" type="video/mp4">\n</video>\n<p>视频内容摘要与文字版要点。</p>\n<link rel="alternate" hreflang="en" href="https://example.com/en/page">' },
  'performance.lcp': { label: '首屏资源示例', language: 'html', code: '<link rel="preload" as="image" href="/hero.webp" fetchpriority="high">\n<img src="/hero.webp" width="1280" height="720" fetchpriority="high" alt="主图描述">' },
  'performance.cls': { label: '稳定布局示例', language: 'css', code: '.hero-media {\n  aspect-ratio: 16 / 9;\n}\n.hero-media img {\n  width: 100%;\n  height: 100%;\n  object-fit: cover;\n}' },
  'performance.fcp': { label: '关键 CSS 示例', language: 'html', code: '<style>/* 只内联首屏必要样式 */</style>\n<link rel="preload" href="/fonts/ui.woff2" as="font" type="font/woff2" crossorigin>\n<script src="/non-critical.js" defer></script>' },
  'performance.ttfb': { label: 'Nginx 缓存示例', language: 'nginx', code: 'location /assets/ {\n  expires 30d;\n  add_header Cache-Control "public, max-age=2592000, immutable";\n}\n# HTML/API 缓存必须按真实更新与登录策略单独配置' },
  'performance.viewport': { label: '通用 HTML 示例', language: 'html', code: '<meta name="viewport" content="width=device-width, initial-scale=1">' },
  'technical.transport': { label: 'Nginx 入口统一示例', language: 'nginx', code: 'server {\n  listen 80;\n  server_name example.com www.example.com;\n  return 301 https://www.example.com$request_uri;\n}\n\n# HTTPS 正式站点直接返回内容，避免再跳一次' },
  'technical.compression': { label: 'Nginx 文本压缩示例', language: 'nginx', code: 'gzip on;\ngzip_vary on;\ngzip_types text/css application/javascript application/json application/xml image/svg+xml;' },
  'technical.cache': { label: 'Nginx 分类缓存示例', language: 'nginx', code: 'location /assets/ {\n  expires 1y;\n  add_header Cache-Control "public, max-age=31536000, immutable";\n}\nlocation / {\n  add_header Cache-Control "no-cache";\n}' },
  'technical.resources': { label: '脚本加载示例', language: 'html', code: '<script src="/navigation.js" defer></script>\n<script src="/independent-analytics.js" async></script>' },
  'technical.crawler-access': { label: '原始 HTML 交付示例', language: 'html', code: '<main>\n  <h1>服务端或静态 HTML 中的主标题</h1>\n  <p>不依赖用户点击或接口成功才出现的主要内容。</p>\n</main>' },
  'links.nofollow-policy': { label: '链接关系示例', language: 'html', code: '<a href="/guide">正常内部链接</a>\n<a href="https://partner.example" rel="sponsored nofollow">付费合作</a>\n<a href="https://user.example" rel="ugc nofollow">用户内容</a>' },
};

export function getFindingCodeAdvice(finding: AuditFinding): FindingCodeAdvice {
  const configured = CODE_ADVICE[finding.ruleId];
  if (configured) {
    return {
      ...configured,
      note: '请按网站实际框架和模板变量改写；示例用于说明最终输出目标，修改后检查最终 HTML 与页面行为。',
    };
  }
  if (finding.codeExample) {
    return {
      label: '通用代码示例',
      language: 'html',
      code: finding.codeExample,
      note: '请按网站实际技术栈改写，并在测试环境验证最终输出。',
    };
  }
  return {
    label: '内容 / 数据配置项',
    language: 'text',
    code: null,
    note: '这项不能仅靠一段前端代码可靠修复。请按修改步骤调整内容、业务口径或数据配置，再用对应指标验证。',
  };
}

const PRIORITY_ORDER: Record<AuditPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

const EXPECTED_OUTCOMES: Record<AuditCategory, string> = {
  discoverability: '减少抓取与索引信号冲突，让搜索引擎更稳定地访问和判断页面。是否实际收录仍需在搜索平台验证。',
  metadata: '让搜索引擎和用户更快理解页面主题，改善搜索摘要的相关性与潜在点击表现。点击率变化需用搜索平台数据对比。',
  content: '让正文主题、层级和实体关系更清楚，帮助搜索引擎理解内容，也降低用户阅读和决策成本。',
  links: '形成更清晰的站内发现路径并传递页面关系，帮助用户和搜索引擎到达重要页面。',
  media: '改善无障碍体验、媒体语义与页面稳定性，并为富媒体理解提供更完整的机器可读信号。',
  performance: '缩短用户等待、减少视觉跳动，改善本次访问体验，并可能提升互动和转化；真实效果需结合现场数据验证。',
};

export function getExpectedOutcome(finding: AuditFinding): string {
  return EXPECTED_OUTCOMES[finding.category];
}

function sortFindings(findings: AuditFinding[]): AuditFinding[] {
  return [...findings].sort((left, right) => {
    const priority = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
    if (priority !== 0) return priority;
    if (left.status !== right.status) return left.status === 'failure' ? -1 : 1;
    return right.points - left.points;
  });
}

export function buildRecommendationSections(findings: AuditFinding[]): RecommendationSection[] {
  const actionable = sortFindings(
    findings.filter((finding) => finding.status === 'failure' || finding.status === 'warning'),
  );

  const urgent = actionable.filter((finding) => finding.priority === 'P0' || finding.priority === 'P1');
  const quickWins = actionable.filter((finding) => finding.priority === 'P2' && finding.effort === '低');
  const planned = actionable.filter((finding) => finding.priority === 'P2' && finding.effort !== '低');
  const watch = actionable.filter((finding) => finding.priority === 'P3');

  return [
    {
      id: 'urgent',
      title: '立即处理',
      description: '先解除索引阻断和高影响风险，再投入增长优化。',
      findings: urgent,
    },
    {
      id: 'quick_wins',
      title: '快速收益',
      description: '工作量较低、适合本次迭代直接完成的改进。',
      findings: quickWins,
    },
    {
      id: 'planned',
      title: '内容增长',
      description: '需要内容、开发或设计协作排期的增长项。',
      findings: planned,
    },
    {
      id: 'watch',
      title: '等待数据',
      description: '先保留证据和基线，结合搜索或业务数据决定是否处理。',
      findings: watch,
    },
  ];
}

export function groupRecommendationsByRootCause(findings: AuditFinding[]): RootCauseRecommendation[] {
  const groups = new Map<string, AuditFinding[]>();
  for (const finding of sortFindings(findings.filter((item) => item.status === 'failure' || item.status === 'warning'))) {
    const items = groups.get(finding.rootCauseId) ?? [];
    items.push(finding);
    groups.set(finding.rootCauseId, items);
  }
  return [...groups.entries()].map(([id, items]) => ({
    id,
    title: items[0]!.title,
    priority: items[0]!.priority,
    findings: items,
    affectedUrls: [...new Set(items.flatMap((item) => item.affectedUrls))],
  }));
}
