import type { AuditRule } from './helpers';
import { comparableUrl, normalizeUrl } from './helpers';
import { isMainContentRenderDependent } from '../rendering';

function directives(values: string[]): string[] {
  return values
    .flatMap((value) => value.toLocaleLowerCase().split(/[;,]/))
    .map((value) => value.trim())
    .filter(Boolean);
}

export const discoverabilityRules: AuditRule[] = [
  {
    id: 'discoverability.response',
    title: '页面 GET 响应',
    category: 'discoverability',
    points: 6,
    run(snapshot, context) {
      const { page } = snapshot.siteProbe;
      if (page.status === null) {
        return {
          status: 'not_measurable',
          evidence: page.error || '浏览器未能完成同源 GET 请求。',
          impact: '无法确认爬虫访问当前 URL 时获得的真实状态。',
          explanation: '页面肉眼可见不代表重新请求时仍能稳定交付。',
          recommendation: '检查登录态、网络策略和服务器响应后重新扫描。',
          verification: '使用真实 GET 再次确认状态、最终 URL 和正文。',
        };
      }

      if (context.expectedIndexState === 'unknown' && page.status !== 200) {
        return {
          status: 'informational',
          evidence: `GET 最终返回 ${page.status}，但尚未确认此页面是否应进入搜索结果。`,
          impact: '状态码可能符合下线页、跳转页或受限页的业务目标，也可能是公开页故障。',
          explanation: '索引目标未知时不能把非 200 状态直接判为索引阻断。',
          recommendation: '先在概览确认索引目标；若应索引，再让有效页面最终返回 200。',
          verification: '确认页面任务后重新评估最终 URL、状态码和正文。',
          evidenceSource: 'http_response',
          confidence: 'medium',
        };
      }

      if (context.expectedIndexState === 'index' && page.status !== 200) {
        return {
          status: 'failure',
          priority: page.status >= 500 ? 'P0' : 'P1',
          scoreCap: page.status >= 500 ? 39 : 69,
          evidence: `GET 最终返回 ${page.status}，最终地址为 ${page.finalUrl || snapshot.url}。`,
          impact: '应索引页面无法以正常内容状态稳定交付。',
          explanation: '搜索系统需要通过真实 GET 获取正确状态和正文。',
          recommendation: '让有效页面最终返回 200；迁移页面使用清晰的永久跳转，不存在页面返回 404/410。',
          verification: '重新请求正常页、跳转页和随机不存在页，确认状态与内容一致。',
          effort: '中',
          owner: '开发',
          rollback: '恢复上一版路由或代理配置，并确认核心页面重新返回预期状态。',
          codeExample: "curl -sS -L -o /dev/null -w 'status=%{http_code} final=%{url_effective}\\n' 'PAGE_URL'",
        };
      }

      return {
        status: 'pass',
        evidence: `GET 返回 ${page.status}，内容类型为 ${page.contentType || '未声明'}。`,
        impact: '页面具备基础访问条件。',
        explanation: '真实 GET 状态与当前页面预期一致。',
        recommendation: '保持状态码、正文和页面真实状态一致。',
        verification: '发布后继续抽样检查正常页、跳转页和不存在页。',
        owner: '开发',
      };
    },
  },
  {
    id: 'discoverability.index-directives',
    title: '索引指令',
    category: 'discoverability',
    points: 8,
    run(snapshot, context) {
      const allDirectives = directives([
        ...snapshot.robotsMeta,
        snapshot.siteProbe.page.xRobotsTag,
      ]);
      const hasNoindex = allDirectives.includes('noindex') || allDirectives.includes('none');
      const hasIndex = allDirectives.includes('index') || allDirectives.includes('all');
      const conflict = hasNoindex && hasIndex;
      const evidence = allDirectives.length > 0 ? allDirectives.join(', ') : '未显式声明，默认允许索引。';

      if (conflict) {
        return {
          status: 'failure',
          priority: 'P0',
          scoreCap: 39,
          evidence: `检测到冲突指令：${evidence}`,
          impact: '不同解析器或模板可能得到不一致的索引判断。',
          explanation: 'meta robots 与 X-Robots-Tag 应表达同一个索引目标。',
          recommendation: '删除冲突来源，只保留与页面预期一致的一组指令。',
          verification: '查看最终响应头和最终 HTML，确认只剩一个明确版本。',
          owner: '开发',
          codeExample: '<meta name="robots" content="index,follow">',
        };
      }

      if (context.expectedIndexState === 'unknown' && hasNoindex) {
        return {
          status: 'informational',
          evidence: `检测到 ${evidence}，但尚未确认页面索引目标。`,
          impact: '如果这是公开获客页，noindex 会阻止索引；如果是内部页则可能完全正确。',
          explanation: 'noindex 的严重度取决于页面是否承担搜索获客任务。',
          recommendation: '在概览把索引目标设为“应索引”或“不应索引”后重新计算。',
          verification: '同时检查最终 HTML 与 X-Robots-Tag，并确认业务目标。',
          evidenceSource: 'http_response',
          confidence: 'medium',
        };
      }

      if (context.expectedIndexState === 'index' && hasNoindex) {
        return {
          status: 'failure',
          priority: 'P0',
          scoreCap: 39,
          evidence: `页面预期应索引，但检测到：${evidence}`,
          impact: '页面可能被明确排除在搜索结果之外。',
          explanation: 'noindex 是直接的索引控制信号，不能用内容优化抵消。',
          recommendation: '确认业务目标后，从模板和响应头移除 noindex。',
          verification: '重新扫描最终响应，随后在搜索平台验证索引处理。',
          owner: '开发',
          codeExample: '<meta name="robots" content="index,follow">',
        };
      }

      if (context.expectedIndexState === 'noindex' && !hasNoindex) {
        return {
          status: 'failure',
          priority: 'P1',
          scoreCap: 69,
          evidence: `页面预期不索引，但当前指令为：${evidence}`,
          impact: '内部、测试或登录页面可能进入搜索结果。',
          explanation: '不应索引的页面需要在可抓取响应中提供明确 noindex。',
          recommendation: '在最终 HTML 或响应头加入 noindex，并避免仅依赖 robots.txt。',
          verification: '确认爬虫能访问页面并读取 noindex，再观察索引清理。',
          owner: '开发',
          codeExample: '<meta name="robots" content="noindex,follow">',
        };
      }

      return {
        status: 'pass',
        evidence,
        impact: '索引控制与扫描目标一致。',
        explanation: '当前页面没有互相冲突的索引信号。',
        recommendation: '保持模板和响应头使用同一策略。',
        verification: '发布后同时检查最终 HTML 和响应头。',
        owner: '开发',
      };
    },
  },
  {
    id: 'discoverability.robots',
    title: 'robots.txt 抓取许可',
    category: 'discoverability',
    points: 6,
    run(snapshot, context) {
      const { robots } = snapshot.siteProbe;
      if (robots.status === 404) {
        return {
          status: 'pass',
          evidence: 'robots.txt 返回 404，等同于没有额外抓取限制。',
          impact: '当前路径未被 robots.txt 阻止。',
          explanation: 'robots.txt 不是必需文件，缺失不代表 SEO 故障。',
          recommendation: '只有确需管理抓取路径时再创建规则。',
          verification: '新增规则后重新检查当前路径。',
          owner: '开发',
        };
      }
      if (robots.allowed === null) {
        return {
          status: 'not_measurable',
          evidence: robots.error || `robots.txt 状态为 ${robots.status ?? '未知'}。`,
          impact: '无法确认 Googlebot 对当前路径的抓取许可。',
          explanation: '网络失败或无法解析时不应猜测为阻止或允许。',
          recommendation: '修复 robots.txt 可访问性并重新扫描。',
          verification: '直接 GET robots.txt，使用当前 URL 路径复核规则。',
          owner: '开发',
        };
      }
      if (context.expectedIndexState === 'unknown' && !robots.allowed) {
        return {
          status: 'informational',
          evidence: 'robots.txt 阻止当前路径，但尚未确认页面是否应被抓取和索引。',
          impact: '公开页可能无法被稳定抓取；内部页则可能符合预期。',
          explanation: '抓取限制需要结合页面任务判断。',
          recommendation: '先确认索引目标，再决定是否调整 robots.txt。',
          verification: '使用目标搜索引擎 user-agent 复核当前路径规则。',
          evidenceSource: 'robots',
          confidence: 'medium',
        };
      }
      if (context.expectedIndexState === 'index' && !robots.allowed) {
        return {
          status: 'failure',
          priority: 'P0',
          scoreCap: 39,
          evidence: `robots.txt 不允许 Googlebot 抓取 ${new URL(snapshot.url).pathname}。`,
          impact: '搜索系统可能无法读取正文、canonical 和 noindex 等页面信号。',
          explanation: '抓取受阻与索引目标冲突。',
          recommendation: '缩小 Disallow 范围或增加正确 Allow，避免误伤公开页面。',
          verification: '重新解析 robots.txt，并用真实爬虫测试工具复核。',
          owner: '开发',
          rollback: '恢复修改前 robots.txt，并重新提交上一个已验证版本。',
        };
      }
      return {
        status: 'pass',
        evidence: `Googlebot 对当前路径的结果：${robots.allowed ? '允许抓取' : '禁止抓取'}。`,
        impact: '抓取规则与当前索引目标没有冲突。',
        explanation: 'robots.txt 已按当前路径和 User-Agent 解析。',
        recommendation: '改版或新增目录规则后重新抽样。',
        verification: '同时检查通配规则、Googlebot 规则和大小写路径。',
        owner: '开发',
      };
    },
  },
  {
    id: 'discoverability.canonical',
    title: '规范地址',
    category: 'discoverability',
    points: 6,
    run(snapshot, context) {
      if (context.expectedIndexState === 'noindex') {
        return {
          status: 'not_applicable',
          evidence: '页面预期不索引，canonical 不参与本次评分。',
          impact: '无。',
          explanation: '不索引配置优先于排名版本选择。',
          recommendation: '如页面存在重复关系，仍可人工检查 canonical。',
          verification: '确认不索引目标正确即可。',
        };
      }
      if (snapshot.canonicals.length === 0) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: '最终 DOM 中没有 canonical。',
          impact: '参数或重复路径存在时，首选版本信号较弱。',
          explanation: 'canonical 不是所有页面的强制项，但自指规范地址有助于统一版本。',
          recommendation: '为公开页面输出一个绝对、自指的 canonical，并让内链和 sitemap 使用同一地址。',
          verification: '查看最终 HTML，确认只有一个可解析的绝对地址。',
          owner: '开发',
          codeExample: '<link rel="canonical" href="https://example.com/preferred-path">',
        };
      }
      if (snapshot.canonicals.length > 1) {
        return {
          status: 'failure',
          priority: 'P1',
          scoreCap: 69,
          evidence: `检测到 ${snapshot.canonicals.length} 个 canonical：${snapshot.canonicals.join(' | ')}`,
          impact: '多个首选版本互相冲突。',
          explanation: '页面只能表达一个明确的规范地址。',
          recommendation: '排查模板、插件和脚本，只保留一个 canonical。',
          verification: '比较原始 HTML 与渲染 DOM，确认两处都只有一个版本。',
          owner: '开发',
        };
      }
      const normalized = normalizeUrl(snapshot.canonicals[0]!, snapshot.url);
      if (!normalized) {
        return {
          status: 'failure',
          priority: 'P1',
          scoreCap: 69,
          evidence: `canonical 无法解析：${snapshot.canonicals[0]}`,
          impact: '搜索系统无法稳定理解首选版本。',
          explanation: '规范地址必须是有效 URL。',
          recommendation: '输出 HTTPS 绝对地址并替换模板占位符。',
          verification: '使用 URL 解析器和最终 HTML 复核。',
          owner: '开发',
        };
      }
      if (comparableUrl(normalized) !== comparableUrl(snapshot.url)) {
        return {
          status: 'warning',
          priority: 'P1',
          evidence: `当前页 ${snapshot.url} 指向 ${normalized}。`,
          impact: '当前页面可能不会被选为索引主版本。',
          explanation: '跨页面 canonical 可能合理，也可能是模板误配，需要结合内容关系确认。',
          recommendation: '确认两页内容实质重复；否则改为当前页面自指。',
          verification: '检查目标页状态、内容关系、内链和 sitemap 是否一致。',
          owner: 'SEO',
        };
      }
      return {
        status: 'pass',
        evidence: `canonical 自指：${normalized}`,
        impact: '当前页面主版本信号清晰。',
        explanation: '规范地址与浏览器当前地址一致。',
        recommendation: '保持内链和 sitemap 使用相同版本。',
        verification: '参数页和分页模板上线时继续抽样。',
        owner: 'SEO',
      };
    },
  },
  {
    id: 'discoverability.raw-render',
    title: '原始 HTML 与渲染内容',
    category: 'discoverability',
    points: 4,
    run(snapshot, context) {
      const raw = snapshot.rawComparison;
      if (!raw.available) {
        return {
          status: 'not_measurable',
          evidence: raw.error || '无法获取原始 HTML。',
          impact: '不能判断主要内容是否完全依赖 JavaScript。',
          explanation: '当前 DOM 只能证明用户浏览器最终看到了什么。',
          recommendation: '在允许同源 GET 的页面重新扫描，或人工保存原始响应。',
          verification: '分别比较禁用和启用 JavaScript 时的标题、正文和链接。',
          owner: '开发',
        };
      }
      if (isMainContentRenderDependent(raw, context.expectedIndexState)) {
        return {
          status: 'warning',
          priority: 'P1',
          evidence: `原始文本约 ${raw.rawTextLength} 字符，渲染后约 ${raw.renderedTextLength} 字符。`,
          impact: '主要内容依赖脚本执行，抓取渲染可能延迟或失败。',
          explanation: '客户端渲染可以被处理，但公开核心内容的交付稳定性更弱。',
          recommendation: '优先在静态或服务端 HTML 中输出标题、H1、主要正文和关键链接。',
          verification: '禁用 JavaScript 后确认页面仍能完成主要阅读任务。',
          effort: '高',
          owner: '开发',
          rollback: '保留当前 CSR 版本，在小范围验证 SSR/预渲染版本后再切换。',
        };
      }
      return {
        status: 'pass',
        evidence: `原始文本约 ${raw.rawTextLength} 字符，渲染后约 ${raw.renderedTextLength} 字符。`,
        impact: '核心内容不完全依赖脆弱的客户端渲染。',
        explanation: '原始响应与最终页面的主要内容规模接近。',
        recommendation: '继续保证公开页面的关键内容可直接读取。',
        verification: '发布后在脚本失败场景复查标题、正文和内链。',
        owner: '开发',
      };
    },
  },
];
