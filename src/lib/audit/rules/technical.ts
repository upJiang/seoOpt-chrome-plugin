import type { AuditRule } from './helpers';
import { firstLocator } from './helpers';

const LIMITATION = '这些结果来自当前页面、匿名 GET 和本次浏览会话，不代表实际索引、排名或所有真实用户。';

export const technicalRules: AuditRule[] = [
  {
    id: 'technical.transport',
    title: 'HTTPS 与网站正式地址',
    category: 'discoverability',
    points: 0,
    run(snapshot) {
      const transport = snapshot.technical?.transport;
      if (!transport) return {
        status: 'not_measurable', scoreRatio: null,
        evidence: '当前报告没有服务器入口证据。',
        impact: '无法确认页面协议和主机是否统一。',
        explanation: '旧报告或受限页面可能没有完成技术交付检查。',
        recommendation: '重新扫描页面；需要四入口结果时点击“完整检查网站入口”。',
        verification: '重新扫描并检查当前协议、最终 URL 和入口矩阵。',
      };
      if (transport.status === 'attention') return {
        status: 'warning', priority: 'P2', scoreRatio: null,
        evidence: transport.explanation,
        impact: '多个可访问版本可能分散链接、缓存和规范信号，HTTP 还会降低传输安全性。',
        explanation: 'SEO 不要求必须使用 www，但同一网站应稳定收敛到一个 HTTPS 正式地址。',
        recommendation: '先确定正式主机，再把其他 HTTP/HTTPS、www/非 www 入口直接永久跳转到最终地址；同步更新 Canonical、内链和 Sitemap。',
        verification: '分别请求四个网站入口，确认只经过必要跳转并最终到达同一个 HTTPS 主机。',
        owner: '开发', effort: '中', rootCauseId: 'transport-canonical-host',
        codeExample: 'server {\n  listen 80;\n  server_name example.com www.example.com;\n  return 301 https://www.example.com$request_uri;\n}',
        antiPattern: '不要因为工具提示就强制改成 www，也不要建立 HTTP → HTTPS → www 的多级跳转链。',
        limitations: '浏览器扩展无法读取证书到期时间、证书链、TLS 版本和加密套件。',
      };
      return {
        status: transport.status === 'unavailable' ? 'not_measurable' : 'pass', scoreRatio: null,
        evidence: transport.explanation,
        impact: '当前协议和正式地址没有发现明确冲突。',
        explanation: '可访问入口是否完全统一仍取决于是否运行完整入口检查。',
        recommendation: transport.variants.length ? '保持当前正式主机、Canonical、内链和 Sitemap 一致。' : '发布或迁移后运行完整入口检查。',
        verification: '抽查 HTTP、HTTPS、www 和非 www 入口。', owner: '开发', limitations: LIMITATION,
      };
    },
  },
  {
    id: 'technical.compression',
    title: '文本响应压缩',
    category: 'performance',
    points: 0,
    run(snapshot) {
      const result = snapshot.technical?.compression;
      if (!result) return { status: 'not_measurable', scoreRatio: null, evidence: '没有压缩响应头证据。', impact: '无法判断当前 HTML 是否压缩传输。', explanation: '旧报告或请求失败会缺少响应头。', recommendation: '重新扫描并检查 Content-Encoding。', verification: '查看真实 GET 响应头。' };
      if (result.status === 'attention') return {
        status: 'warning', priority: 'P2', scoreRatio: null,
        evidence: result.explanation,
        impact: 'HTML、CSS 或 JavaScript 传输量可能高于必要水平，增加慢网络下的等待。',
        explanation: 'gzip/Brotli 适合文本资源；图片、视频和已压缩字体不应机械重复压缩。',
        recommendation: '在 CDN 或服务器为 HTML、CSS、JavaScript、JSON、XML 和 SVG 启用 Brotli 或 gzip，并确认响应包含 Content-Encoding。',
        verification: '清除缓存后执行真实 GET，确认 Content-Encoding 与传输体积变化。',
        owner: '开发', effort: '低', rootCauseId: 'response-compression',
        codeExample: 'gzip on;\ngzip_vary on;\ngzip_types text/css application/javascript application/json application/xml image/svg+xml;',
        antiPattern: '不要给 JPG、PNG、WebP、视频和 WOFF2 强制 gzip，也不要只凭正文字符数估算压缩率。',
        limitations: '浏览器会自动解压正文，插件只能依据响应头和可见体积信号判断。',
      };
      return { status: 'pass', scoreRatio: null, evidence: result.explanation, impact: '当前响应没有发现明确压缩浪费。', explanation: '仅对适合压缩且体积超过 1KB 的文本资源提出问题。', recommendation: '继续按资源类型配置压缩。', verification: '发布后抽查主要模板和静态资源响应头。', owner: '开发', limitations: LIMITATION };
    },
  },
  {
    id: 'technical.cache',
    title: '浏览器缓存策略',
    category: 'performance',
    points: 0,
    run(snapshot) {
      const result = snapshot.technical?.cache;
      if (!result) return { status: 'not_measurable', scoreRatio: null, evidence: '没有缓存响应头证据。', impact: '无法判断页面是否重复下载或长期使用旧内容。', explanation: '缓存必须结合页面类型和更新频率判断。', recommendation: '重新扫描并检查 Cache-Control、ETag 和 Last-Modified。', verification: '连续请求同一 URL 并检查响应头。' };
      if (result.status === 'attention' || result.status === 'confirm') return {
        status: 'warning', priority: 'P2', scoreRatio: null,
        evidence: result.explanation,
        impact: '配置不匹配可能造成重复下载，或让用户和搜索系统长期获得旧版本。',
        explanation: '版本化静态资源适合长期缓存；HTML、登录页和接口要按更新频率与隐私分别处理。',
        recommendation: '为带版本指纹的静态资源设置长期缓存；HTML 使用短缓存或重新验证；登录和敏感响应使用 private/no-store。',
        verification: '分别请求 HTML、版本化资源和登录页面，确认策略、304 行为和发布换版符合预期。',
        owner: '开发', effort: '中', rootCauseId: 'cache-policy',
        codeExample: 'location /assets/ {\n  expires 1y;\n  add_header Cache-Control "public, max-age=31536000, immutable";\n}\n\nlocation / {\n  add_header Cache-Control "no-cache";\n}',
        antiPattern: '不要给文件名不变的资源设置一年 immutable，也不要让登录页使用公共缓存。',
        limitations: '插件不知道页面真实更新频率和 CDN 回源规则，因此部分结论只能标为需要确认。',
      };
      return { status: 'pass', scoreRatio: null, evidence: result.explanation, impact: '当前响应具备合理的缓存或重新验证基础。', explanation: '缓存结论按当前资源类型判断。', recommendation: '继续通过版本化文件名和发布验证控制缓存。', verification: '更新资源后确认新版本及时生效。', owner: '开发', limitations: LIMITATION };
    },
  },
  {
    id: 'technical.resources',
    title: 'CSS 与 JavaScript 加载',
    category: 'performance',
    points: 0,
    run(snapshot) {
      const resources = snapshot.technical?.resources;
      if (!resources) return { status: 'not_measurable', scoreRatio: null, evidence: '没有资源加载清单。', impact: '无法判断阻塞和重复加载候选。', explanation: '资源时序只在浏览会话中可采集。', recommendation: '重新加载页面后扫描。', verification: '查看资源清单和浏览器网络瀑布。' };
      const risk = resources.blockingScripts + resources.duplicateUrls.length + (resources.blockingStylesheets > 4 ? resources.blockingStylesheets - 4 : 0);
      if (risk > 0) return {
        status: 'warning', priority: 'P2', scoreRatio: null,
        evidence: `${resources.blockingScripts} 个同步脚本、${resources.blockingStylesheets} 个阻塞样式、${resources.duplicateUrls.length} 个重复资源候选；${resources.unmeasurableSizes} 个资源体积不可测。`,
        impact: '首屏解析可能等待非必要资源，重复请求也会增加网络和主线程成本。',
        explanation: '同步经典脚本会阻塞 HTML 解析；module 默认延后执行。资源数量本身不等于冗余。',
        recommendation: '先确认脚本依赖，再对独立脚本使用 async、依赖 DOM 的脚本使用 defer；删除重复引用，并结合瀑布和 Coverage 复核未使用代码。',
        verification: '修改后复测 FCP/LCP、关键交互、资源瀑布和错误日志。',
        owner: '开发', effort: '中', rootCauseId: 'critical-rendering-path',
        codeExample: '<script src="/navigation.js" defer></script>\n<script src="/independent-analytics.js" async></script>',
        antiPattern: '不要仅凭文件名删除资源，也不要在 HTTP/2/3 下机械合并所有 CSS/JS。',
        limitations: '插件没有调试权限，不能提供准确的未使用代码比例；体积为 0 可能是缓存或跨域限制。',
      };
      return { status: 'pass', scoreRatio: null, evidence: `采集 ${resources.total} 个资源，未发现同步脚本或重复 URL。`, impact: '当前页面没有发现明确的加载结构问题。', explanation: '这不等于所有资源都被实际使用。', recommendation: '继续结合真实用户性能和 Coverage 管理资源预算。', verification: '对主要模板分别复测。', owner: '开发', limitations: LIMITATION };
    },
  },
  {
    id: 'technical.crawler-access',
    title: '搜索爬虫可访问性',
    category: 'discoverability',
    points: 0,
    run(snapshot) {
      const crawler = snapshot.technical?.crawler;
      if (!crawler || crawler.status === 'unavailable') return { status: 'not_measurable', scoreRatio: null, evidence: crawler?.explanation || '没有匿名 GET 证据。', impact: '无法确认公开访问时搜索系统能获得什么。', explanation: '浏览器可见不等于匿名请求也能获得完整内容。', recommendation: '修复请求失败或权限问题后重新扫描。', verification: '用匿名真实 GET 获取状态、响应头和原始 HTML。', limitations: '这不是 Googlebot 身份模拟。' };
      if (crawler.status === 'attention' || crawler.status === 'confirm') return {
        status: 'warning', priority: crawler.status === 'attention' ? 'P1' : 'P2', scoreRatio: null,
        evidence: crawler.explanation,
        impact: '搜索系统可能无法稳定取得页面，或需要额外渲染才能获得关键内容。',
        explanation: '搜索爬虫首先获得服务器返回的原始响应；浏览器最终能显示不代表交付链路稳定。',
        recommendation: '让公开页面匿名 GET 返回正确状态，并在原始 HTML 输出标题、主要正文、Canonical 和关键内部链接。',
        verification: '禁用 JavaScript或直接查看原始响应，确认关键内容仍存在；再结合服务器日志验证真实抓取。',
        owner: '开发', effort: '中', rootCauseId: 'crawler-delivery',
        codeExample: '<main>\n  <h1>服务端或静态 HTML 中的真实主标题</h1>\n  <p>不依赖用户点击或接口成功才出现的主要内容。</p>\n</main>',
        antiPattern: '不要根据 User-Agent 给搜索引擎返回一套用户看不到的特殊内容。',
        limitations: '匿名 GET 不能证明真实 Googlebot 身份、抓取频率、索引状态或排名。',
      };
      return { status: 'pass', scoreRatio: null, evidence: crawler.explanation, impact: '当前页面具备基础匿名访问和原始内容交付条件。', explanation: '真实抓取仍需服务器日志验证。', recommendation: '保持状态、robots、原始 HTML 和渲染结果一致。', verification: '发布后抽样匿名 GET 并观察日志。', owner: '开发', limitations: '这不是 Googlebot 身份模拟。' };
    },
  },
  {
    id: 'links.nofollow-policy',
    title: 'nofollow 链接关系',
    category: 'links',
    points: 0,
    run(snapshot, context) {
      const summary = snapshot.technical?.links;
      if (!summary) return { status: 'not_measurable', scoreRatio: null, evidence: '没有链接 rel 汇总。', impact: '无法判断 nofollow 是否影响站内发现。', explanation: '需要读取最终 DOM 中的链接 rel。', recommendation: '重新扫描页面。', verification: '检查页面级 robots 和链接 rel。' };
      const affected = snapshot.links.filter((link) => link.isInternal && link.rel.includes('nofollow'));
      if ((summary.pageNofollow && context.expectedIndexState === 'index') || summary.internalNofollow > 0) return {
        status: 'warning', priority: summary.pageNofollow && context.expectedIndexState === 'index' ? 'P1' : 'P2', scoreRatio: null,
        evidence: `${summary.pageNofollow ? '页面声明 nofollow；' : ''}${summary.internalNofollow} 个内部链接、${summary.externalNofollow} 个外部链接含 nofollow。`,
        impact: '重要内部页面的发现和关系表达可能被削弱。',
        explanation: 'nofollow 是链接关系提示，不是站内权重雕刻、保密或阻止抓取工具。',
        recommendation: '公开导航和正文内链通常保持可跟随；付费链接使用 sponsored，用户生成内容使用 ugc，并按真实关系决定是否同时 nofollow。',
        verification: '检查修改后的页面级 robots 和关键链接 rel，再从导航完成一次真实路径。',
        owner: 'SEO', effort: '低', rootCauseId: 'link-rel-policy', locator: firstLocator(affected),
        codeExample: '<a href="/guide">正常内部链接</a>\n<a href="https://partner.example" rel="sponsored nofollow">付费合作</a>\n<a href="https://user.example" rel="ugc nofollow">用户内容</a>',
        antiPattern: '不要给所有外链机械添加 nofollow，也不要用 nofollow 保护敏感页面。',
        limitations: '插件无法仅凭 DOM 确认一条外链是否付费或来自用户内容。',
      };
      return { status: 'pass', scoreRatio: null, evidence: `内部 nofollow ${summary.internalNofollow} 个，ugc ${summary.ugc} 个，sponsored ${summary.sponsored} 个。`, impact: '当前没有发现明确的站内 nofollow 风险。', explanation: '普通自然外链不要求机械 nofollow。', recommendation: '继续按链接真实关系设置 rel。', verification: '抽查广告、用户内容和主要内链。', owner: 'SEO', limitations: LIMITATION };
    },
  },
];
