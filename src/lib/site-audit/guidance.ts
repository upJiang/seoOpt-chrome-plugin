import type { SiteAuditIssue } from '../projects/types';

export interface SiteIssueGuidance {
  impact: string;
  recommendation: string;
  verification: string;
}

const GUIDANCE: Record<string, SiteIssueGuidance> = {
  'site.entry': {
    impact: '同一网站如果有多个 HTTP/HTTPS 或 www/非 www 版本同时可用，链接、缓存和规范信号会被分散；过长或循环跳转还会增加用户和爬虫失败概率。',
    recommendation: '先确定一个正式 HTTPS 主机，把其他可访问入口直接永久跳转到它，并同步 Canonical、站内链接和 Sitemap。www 不是硬性要求，目标是只保留一个稳定版本。',
    verification: '分别请求 HTTP/HTTPS、www/非 www 入口，确认没有降级、循环或多级跳转，最终都到达同一个 HTTPS 主机；保留旧配置以便异常时回滚。',
  },
  'site.robots-syntax': {
    impact: 'robots.txt 格式错误可能让搜索引擎忽略一条规则或整个分组，结果可能与维护人员的意图相反。它不会代替 noindex，也不能保证页面从索引中移除。',
    recommendation: '按 User-agent 分组整理 Allow 与 Disallow，每行只保留“指令: 值”。删除拼写错误和无效占位行；先在测试环境核对匹配路径，再发布到网站根目录。',
    verification: '重新请求 /robots.txt，确认返回 200 和纯文本；分别用 Googlebot、Bingbot、Baiduspider 与通用规则测试首页、核心目录和静态资源路径。',
  },
  'site.robots-directive': {
    impact: '非标准指令可能只被少数搜索引擎识别，其他爬虫会直接忽略，导致团队误以为已经控制抓取或索引。',
    recommendation: '查清每条指令针对的平台和目的。需要禁止收录时使用页面 noindex；需要控制抓取时使用被目标搜索引擎支持的 Allow/Disallow，不把非标准指令当作通用规则。',
    verification: '在目标搜索平台的 robots 测试或抓取报告中核对，并从服务器日志观察目标目录是否仍被请求。',
  },
  'site.compression': {
    impact: 'HTML、CSS 和 JavaScript 没有传输压缩时，会增加下载字节和移动网络等待，间接拖慢页面渲染与搜索爬虫获取资源。',
    recommendation: '在 CDN 或 Web 服务器为 text、JavaScript、JSON、XML、SVG 启用 Brotli 或 gzip；不要重复压缩图片、视频和 WOFF2 字体。优先在服务器层统一配置，不逐页修改代码。',
    verification: '用真实 GET 检查 Content-Encoding，并比较修改前后的传输体积；同时确认响应正文未损坏、Vary 包含 Accept-Encoding。',
  },
  'site.cache': {
    impact: '缓存过短会造成重复下载，过长且没有版本号又可能让用户继续使用旧资源。HTML、静态资源、登录页和接口需要不同策略。',
    recommendation: '带内容指纹的 CSS/JS 使用长期缓存和 immutable；公开 HTML 使用短缓存或重新验证；登录态和敏感响应使用 private/no-store。不要给所有响应复制同一条缓存配置。',
    verification: '抽查 HTML、版本化资源和登录页面的 Cache-Control、ETag/Last-Modified，发布新版本后确认新文件名能立即生效。',
  },
  'site.nofollow': {
    impact: '站内导航或正文链接使用 nofollow 会削弱页面之间的发现路径和关系表达；页面级 nofollow 还会影响该页链接的处理。',
    recommendation: '普通站内链接保持可跟随。只有付费链接使用 sponsored、用户生成内容使用 ugc；外链是否 nofollow 要按关系判断，不要批量给所有外链或内链添加。',
    verification: '抽查受影响页面的原始 HTML，确认主要导航、分页、相关文章和核心 CTA 不再误用 nofollow；重新运行相同样本。',
  },
  'site.robots-resources': {
    impact: '搜索引擎如果无法抓取渲染所需的 CSS 或 JavaScript，可能看不到真实布局、正文或移动适配；图片被阻止也会影响图片理解。',
    recommendation: '从 robots.txt 中放开页面渲染必需的静态资源目录。不要为了减少抓取而整段禁止 /assets、/static、/js 或 /css；敏感接口应靠鉴权保护。',
    verification: '分别测试被标记资源在通用、Google、Bing 和百度规则下可访问，并再次比较原始 HTML、渲染内容和搜索平台抓取结果。',
  },
  'site.sitemap-missing': {
    impact: '页面清单是网站主动告诉搜索引擎“哪些地址值得发现”的入口。没有可用 Sitemap 不一定阻止收录，但新页面和深层页面更容易被发现得慢。',
    recommendation: '确认网站是否有公开的 XML Sitemap。生成只包含 200、规范且允许收录的 URL，并在 robots.txt 中声明；页面较多时使用 Sitemap index 拆分。不要把 noindex、参数页和 404 地址塞进清单。',
    verification: '直接请求 Sitemap，确认返回 200、XML 能解析，URL 与网站主域名一致；抽查其中地址的状态、Canonical 和 noindex 后重新运行站点审计。',
  },
  'site.sitemap-invalid': {
    impact: '无效或跨域地址会让搜索引擎在 Sitemap 中遇到无法访问的目标，降低清单的可信度并浪费抓取请求。',
    recommendation: '清理跨域、带片段、跳转链、404、非规范和不允许收录的地址。Sitemap index 的子文件保持同源或明确被搜索引擎接受，并修正 XML 转义和 lastmod 格式。',
    verification: '逐个抽查被标记的地址，确认最终 URL 返回 200 且可索引；再次下载 Sitemap，确认 XML 结构和 URL 数量正确。',
  },
  'site.sitemap-lastmod': {
    impact: '无效或机械伪造的更新时间会让搜索引擎难以判断页面是否真的发生变化，也会让运维人员误判更新范围。',
    recommendation: '把 lastmod 输出为页面实际发生重要内容变更的 ISO 日期，例如 2026-08-05 或带时区的完整时间；没有可靠更新时间时宁可省略，不要每次构建都批量改成当天。',
    verification: '重新下载 Sitemap，确认所有 lastmod 都能按 ISO 日期解析，并抽查它是否对应页面真实更新时间。',
  },
  'site.canonical-target': {
    impact: 'Canonical 目标如果 404、跳转、noindex 或无法测，搜索引擎无法稳定理解你希望保留哪一个版本，页面信号可能被丢弃。',
    recommendation: '让 Canonical 指向最终的、返回 200 且允许收录的规范 URL。若页面不应独立存在，改为真实 301 或从 Sitemap/内链中移除，不要把所有页面都指向首页。',
    verification: '用 GET 检查目标地址的最终状态、Canonical 和 robots 指令，确认没有跳转链或 noindex；修改后重跑同一批页面。',
  },
  'site.pagination-canonical': {
    impact: '把所有分页都 Canonical 到第一页可能让后续页的商品、文章或列表内容难以被发现；但如果分页只是重复视图，也可能是正确选择。',
    recommendation: '先确认分页是否承载独立内容。可继续收录的分页使用稳定自指 Canonical，并保证上一页/下一页和分类入口可达；纯筛选或重复视图则统一规范到真正的主页面并控制抓取。',
    verification: '抽查第 2 页及更深页面，确认 Canonical、内链和 Sitemap 策略一致，并观察搜索爬虫是否能访问新增内容。',
  },
  'site.search-indexable': {
    impact: '站内搜索结果页通常由任意查询组合生成，内容薄、重复多且没有稳定的搜索需求，开放收录容易造成低价值 URL 膨胀。',
    recommendation: '默认让站内搜索结果页 noindex,follow，并在 robots/Sitemap/站内链接中控制无价值参数。只有经过人工策划、有独立内容和稳定需求的专题页才单独开放收录。',
    verification: '确认搜索页的 meta robots、Canonical 和参数策略；测试不同查询不会无限生成可索引组合，重新检查搜索 URL 数量。',
  },
  'site.url-expansion': {
    impact: '标签、筛选、排序和搜索参数可能把少量内容扩展成大量地址，消耗抓取预算并制造重复页面，真正重要的页面反而被延后处理。',
    recommendation: '按页面任务建立 URL 白名单：有搜索价值的固定分类/专题页保留；排序、组合筛选、空结果和临时参数使用 noindex、Canonical 或在链接层阻断。避免只用 robots.txt 隐藏已被发现的 URL。',
    verification: '统计一周内新增参数 URL，检查主要模板的 robots、Canonical、Sitemap 和内链是否一致，再逐步扩大样本确认膨胀速度下降。',
  },
  'site.empty-content': {
    impact: '返回 200 但正文为空的页面可能被搜索引擎视为软 404，用户也无法完成页面任务；常见原因是 CSR 渲染失败、数据接口错误或模板条件分支。',
    recommendation: '确认页面是否应该存在。应保留的页面让首屏和原始 HTML 提供真实主题、标题和主要内容，并处理接口失败状态；无内容页面返回明确 404/410 或从 Sitemap 移除。不要用大量占位文字掩盖空页面。',
    verification: '用禁用 JavaScript 和普通浏览器分别请求，确认主要内容在预期渲染阶段出现；检查状态码、Canonical 和 Sitemap 后再复测。',
  },
  'site.near-duplicate': {
    impact: '正文只做轻微改写的页面可能竞争同一搜索需求，搜索引擎难以选择展示版本，维护和抓取资源也会被分散。',
    recommendation: '按用户任务合并真正重复的页面并 301；必须保留的变体说明差异并使用正确 Canonical；需要独立排名的页面补充独有证据、实体、例子和内链。',
    verification: '人工比较候选页面的搜索任务和可见内容，确认处理方案后重新抽样，检查重复候选数量和页面入口是否符合预期。',
  },
  'site.template-overlap': {
    impact: '同一个模板错误会一次影响一批页面。若模板只输出固定标题、描述或空内容，逐页修改不仅浪费时间，还会在下一次发布时复发。',
    recommendation: '找到负责该 URL 模式的模板或数据映射，先修模板变量、默认值和异常状态，再为不同页面任务补充真正不同的内容。保留一个正常页和一个异常页作为回归样本。',
    verification: '发布后抽查同一模板的首页、中间页和边界页，比较 Title、H1、正文、Canonical 和状态码，确认批量问题已下降。',
  },
  'site.hreflang-reciprocal': {
    impact: '多语言声明需要相互指回并且目标页面可访问、可收录。互返或 Canonical 不一致时，搜索引擎可能忽略部分语言信号。',
    recommendation: '为每个语言版本设置自引用 hreflang、互相返回的语言链接和必要的 x-default；目标页面返回 200、语言与内容一致，Canonical 不要跨语言错误合并。',
    verification: '逐页核对语言矩阵、状态码、Canonical 和 Sitemap，确认 A 指向 B 时 B 也指向 A，并重跑多语言样本。',
  },
  'site.schema-semantic': {
    impact: '结构化数据即使 JSON 能解析，字段与页面可见内容不一致也可能无法获得富结果，严重时会降低数据可信度。',
    recommendation: '按页面类型补齐真实字段：文章核对作者和日期，商品核对价格、币种、库存，面包屑核对层级和 URL。不要标记页面上看不到的评分、价格或日期。',
    verification: '比较结构化字段和页面可见内容，修复后重新解析 JSON-LD，并在搜索平台的富结果报告中观察是否仍有警告。',
  },
  'site.response': {
    impact: '打不开或返回错误状态的页面无法稳定承接搜索流量，也会浪费搜索引擎抓取资源。',
    recommendation: '逐个确认受影响 URL 是否仍应存在：需要保留的页面修复服务器错误并恢复 200；已迁移的页面 301 到最相关的新地址；已删除且没有替代内容的页面返回明确 404/410，并从 Sitemap 和站内链接中移除。',
    verification: '重新请求这些 URL，确认最终状态和跳转目标符合预期，再运行一次站点检查；同时确认 Sitemap 和页面内链接不再指向失效地址。',
  },
  'site.sitemap-noindex': {
    impact: 'Sitemap 表示“希望搜索引擎发现这个页面”，noindex 表示“不要收录”，两种信号互相冲突，会浪费抓取并让维护人员误判。',
    recommendation: '先确认每个页面是否应该出现在搜索结果中。应该收录的页面移除 noindex；不应该收录的页面保留 noindex，并从 Sitemap 中删除。不要直接批量删除所有 noindex。',
    verification: '抽查受影响页面的原始 HTML 和响应头，并重新生成 Sitemap，确保 Sitemap 中只保留允许收录、能正常返回的规范 URL。',
  },
  'site.canonical': {
    impact: 'Canonical 指向其他地址时，搜索引擎可能把当前页面的信号合并到目标 URL；如果不是有意合并，当前页面可能难以独立获得排名。',
    recommendation: '按页面用途确认是否为有意合并。独立页面应使用指向自身规范地址的 Canonical；参数页、重复页或打印页可以继续指向主版本，但目标页面应可访问且允许收录。',
    verification: '抽查页面源代码，确认 Canonical 使用绝对地址、目标返回 200，且跳转后的最终地址与预期一致。修改后重新运行站点检查。',
  },
  'site.duplicate-title': {
    impact: '多个页面使用相同标题时，搜索引擎和用户都难以区分页面用途，页面之间也可能竞争同一个搜索需求。',
    recommendation: '检查是否由同一模板固定输出标题。让标题包含页面自己的主题、产品、分类或地区信息，并与该页 H1 和主要任务保持一致；不要只追加随机编号来制造差异。',
    verification: '抽查受影响页面，确认每个可收录页面的 Title 能准确区分页面主题，再重新检查重复标题数量是否下降。',
  },
  'site.duplicate-description': {
    impact: '重复描述通常不会直接阻止收录，但会让搜索结果摘要缺乏区分度，可能降低用户点击意愿。',
    recommendation: '为重要页面生成与其内容和用户任务一致的独立描述。无法稳定维护高质量描述时，可以让搜索引擎从正文生成摘要，不要批量填入相同宣传语。',
    verification: '抽查搜索价值较高的页面，确认 Description 能说明该页独有内容和下一步行动，并重新检查重复数量。',
  },
  'site.duplicate-contentFingerprint': {
    impact: '大量正文高度重复会分散页面信号、消耗抓取资源，也会让搜索引擎难以判断应该展示哪个页面。',
    recommendation: '先按页面任务判断处理方式：用途相同的页面合并并 301；必须保留的重复版本使用 Canonical；不需要参与搜索的页面 noindex；需要独立排名的页面补充真正不同的内容、证据和用户任务。',
    verification: '重新抽查受影响页面，确认保留页面的正文和搜索任务存在实质差异，并检查合并、Canonical 或 noindex 是否符合预期。',
  },
  'site.orphan-candidate': {
    impact: '只有 Sitemap 提供地址、却没有站内链接入口的页面，用户和搜索引擎都更难自然发现，重要性信号也较弱。',
    recommendation: '确认页面是否值得被搜索。重要页面应从相关分类页、专题页、正文或导航中增加可点击的上下文链接；不需要收录的页面应从 Sitemap 移除。',
    verification: '从首页或主要分类页沿链接检查是否能到达目标页面，并重新运行站点检查。这里只是采样候选，最终还应结合完整爬虫或服务器日志确认。',
  },
};

const DISPLAY_TITLES: Record<string, string> = {
  'site.entry': '网站访问入口没有稳定收敛',
  'site.robots-syntax': '抓取规则（robots.txt）存在格式风险',
  'site.robots-directive': '抓取规则包含需要确认的非标准指令',
  'site.compression': '部分文本页面没有启用传输压缩',
  'site.cache': '部分页面或资源缓存策略需要调整',
  'site.nofollow': '站内主要链接或页面级 nofollow 需要确认',
  'site.robots-resources': '抓取规则可能阻止页面渲染所需资源',
  'site.sitemap-missing': '没有找到可用的页面清单（Sitemap）',
  'site.sitemap-invalid': '页面清单中有无效或跨域地址',
  'site.sitemap-lastmod': '页面清单中的更新时间格式无效',
  'site.canonical-target': '首选地址的目标页面不可正常收录',
  'site.pagination-canonical': '分页页面都指向第一页的首选地址',
  'site.search-indexable': '站内搜索结果页可能被搜索引擎收录',
  'site.url-expansion': '筛选、标签或搜索 URL 可能造成页面膨胀',
  'site.empty-content': '部分页面返回成功但主要正文几乎为空',
  'site.near-duplicate': '发现正文开头高度相似的页面候选',
  'site.template-overlap': '同一页面模板可能复用了不区分页面的内容',
  'site.hreflang-reciprocal': '多语言页面的 hreflang 互相声明不完整',
  'site.schema-semantic': '结构化数据字段与页面内容可能不一致',
  'site.response': '页面打不开或返回错误',
  'site.sitemap-noindex': '网站页面清单和“不收录”设置互相冲突',
  'site.canonical': '页面声明的首选地址指向了其他页面',
  'site.duplicate-title': '多个页面使用了相同标题',
  'site.duplicate-description': '多个页面使用了相同描述',
  'site.duplicate-contentFingerprint': '多个页面的主要正文重复',
  'site.orphan-candidate': '页面可能缺少其他站内页面的链接入口',
};

const FALLBACK_GUIDANCE: SiteIssueGuidance = {
  impact: '这个问题可能同时影响本次样本中的多个页面，需要结合页面用途确认真实影响。',
  recommendation: '先查看受影响 URL，判断它们是否属于同一模板或页面类型，再从模板层修复，避免逐页重复修改。',
  verification: '修改后重新运行相同范围的站点检查，并抽查受影响 URL 的原始 HTML 和最终响应。',
};

export function getSiteIssueGuidance(issue: Pick<SiteAuditIssue, 'code' | 'impact' | 'recommendation' | 'verification'>): SiteIssueGuidance {
  const fallback = GUIDANCE[issue.code] ?? FALLBACK_GUIDANCE;
  return {
    impact: issue.impact || fallback.impact,
    recommendation: issue.recommendation || fallback.recommendation,
    verification: issue.verification || fallback.verification,
  };
}

export function siteIssueGuidanceForCode(code: string): SiteIssueGuidance {
  return GUIDANCE[code] ?? FALLBACK_GUIDANCE;
}

export function getSiteIssueDisplayTitle(issue: Pick<SiteAuditIssue, 'code' | 'title'>): string {
  return DISPLAY_TITLES[issue.code] ?? issue.title;
}
