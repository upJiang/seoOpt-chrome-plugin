import type { AuditRule } from './helpers';
import { firstLocator } from './helpers';

export const linkRules: AuditRule[] = [
  {
    id: 'links.valid-hrefs',
    title: '链接地址有效性',
    category: 'links',
    points: 3,
    run(snapshot) {
      if (snapshot.links.length === 0) {
        return {
          status: 'not_applicable',
          evidence: '页面没有可评估的链接元素。',
          impact: '由内部链接入口规则单独评估。',
          explanation: '避免重复扣分。',
          recommendation: '检查页面是否确实不需要导航或下一步入口。',
          verification: '补充链接后重新扫描。',
        };
      }
      const invalid = snapshot.links.filter((link) => {
        const href = link.rawHref.trim().toLocaleLowerCase();
        return !href || href.startsWith('javascript:') || href === '#';
      });
      if (invalid.length > 0) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: `${invalid.length}/${snapshot.links.length} 个链接为空、仅为 # 或使用 javascript:。`,
          impact: '用户和爬虫无法获得稳定、可跟随的目的地址。',
          explanation: '按钮行为不应伪装成不可抓取链接，导航链接应具有真实 href。',
          recommendation: '导航使用真实 URL；纯交互使用 button，并提供合适的键盘行为。',
          verification: '逐项打开链接并在禁用 JavaScript 时检查关键路径。',
          owner: '开发',
          locator: firstLocator(invalid),
        };
      }
      return {
        status: 'pass',
        evidence: `${snapshot.links.length} 个链接均具有可解析目的地址。`,
        impact: '当前链接可以被用户和抓取系统处理。',
        explanation: '未发现空 href、javascript: 或孤立 #。',
        recommendation: '继续用真实链接承载导航，用 button 承载操作。',
        verification: '改版后复查关键路径。',
        owner: '开发',
        locator: firstLocator(snapshot.links),
      };
    },
  },
  {
    id: 'links.anchor-text',
    title: '链接可访问名称',
    category: 'links',
    points: 2,
    run(snapshot) {
      if (snapshot.links.length === 0) {
        return {
          status: 'not_applicable',
          evidence: '没有链接。',
          impact: '无。',
          explanation: '没有可评估对象。',
          recommendation: '无。',
          verification: '新增链接后重新扫描。',
        };
      }
      const unnamed = snapshot.links.filter((link) => !link.accessibleName.trim());
      if (unnamed.length > 0) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: `${unnamed.length}/${snapshot.links.length} 个链接没有可访问名称。`,
          impact: '链接关系缺少上下文，辅助技术用户也难以理解。',
          explanation: '可见文字、aria-label 或链接图片 Alt 至少应提供一种清晰名称。',
          recommendation: '使用描述目的的锚文本，避免大量“点击这里”和空图标链接。',
          verification: '用链接列表和屏幕阅读器检查名称。',
          owner: '内容',
          locator: firstLocator(unnamed),
        };
      }
      return {
        status: 'pass',
        evidence: '所有链接都有可访问名称。',
        impact: '链接目的更容易理解。',
        explanation: '链接至少具有文字、标签或图片替代文本。',
        recommendation: '名称应继续描述目的，而不是堆叠关键词。',
        verification: '抽样检查重复的通用锚文本。',
        owner: '内容',
        locator: firstLocator(snapshot.links),
      };
    },
  },
  {
    id: 'links.internal-entry',
    title: '内部链接入口',
    category: 'links',
    points: 2,
    run(snapshot, context) {
      if (context.expectedIndexState === 'noindex' || context.pageType === 'internal_app') {
        return {
          status: 'not_applicable',
          evidence: '当前页面不按公开搜索入口评估。',
          impact: '内部链接数量不参与评分。',
          explanation: '登录工具和不索引页面不需要套用公开内容规则。',
          recommendation: '仍应保证真实用户导航可用。',
          verification: '进行产品导航测试。',
        };
      }
      const internal = snapshot.links.filter((link) => link.isInternal && !link.isFragment);
      if (internal.length === 0) {
        return {
          status: 'warning',
          priority: 'P1',
          evidence: '页面没有指向同源其他页面的普通链接。',
          impact: '页面无法向重要页面传递主题关系，也可能形成访问终点。',
          explanation: '单页无法证明是否孤立，但零内部链接是需要人工确认的风险。',
          recommendation: '增加与当前任务相关的栏目、详情或下一步链接。',
          verification: '从导航和正文完成一次真实任务路径。',
          owner: 'SEO',
        };
      }
      return {
        status: 'pass',
        evidence: `检测到 ${internal.length} 个指向同源页面的链接。`,
        impact: '页面具备基础站内发现路径。',
        explanation: '当前页面能连接到站内其他地址。',
        recommendation: '是否真正孤立仍需结合站内反向入口或爬取数据判断。',
        verification: '用站内爬取或日志确认哪些页面链接到当前页。',
        owner: 'SEO',
        locator: firstLocator(internal),
      };
    },
  },
  {
    id: 'links.fragments',
    title: '页内锚点',
    category: 'links',
    points: 1,
    run(snapshot) {
      const fragments = snapshot.links.filter((link) => link.isFragment);
      if (fragments.length === 0) {
        return {
          status: 'not_applicable',
          evidence: '页面没有页内锚点链接。',
          impact: '该规则不参与评分。',
          explanation: '没有可评估对象。',
          recommendation: '长页面可按用户任务增加目录。',
          verification: '新增目录后复查。',
        };
      }
      const broken = fragments.filter((link) => !link.fragmentExists);
      if (broken.length > 0) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: `${broken.length}/${fragments.length} 个页内链接找不到目标元素。`,
          impact: '目录或跳转操作无法到达承诺位置。',
          explanation: 'hash 必须与目标 id 或 name 一致。',
          recommendation: '修复目标 id、链接 hash 或动态渲染时序。',
          verification: '逐个点击并确认地址、焦点和滚动位置。',
          owner: '开发',
          locator: firstLocator(broken),
        };
      }
      return {
        status: 'pass',
        evidence: `${fragments.length} 个页内锚点均能定位目标。`,
        impact: '长页面导航可用。',
        explanation: 'hash 与目标元素匹配。',
        recommendation: '动态内容更新时保持 id 稳定。',
        verification: '键盘与鼠标分别测试。',
        owner: '开发',
        locator: firstLocator(fragments),
      };
    },
  },
  {
    id: 'links.pagination',
    title: '列表分页发现路径',
    category: 'links',
    points: 2,
    run(snapshot, context) {
      if (context.pageType !== 'category') {
        return {
          status: 'not_applicable',
          evidence: '当前页面未被结构化数据或分页链接识别为分类页。',
          impact: '分页规则不参与评分。',
          explanation: '分页只对承载多批内容的列表页适用。',
          recommendation: '如页面实际为列表页，请补充准确的类型信号和可抓取分页链接。',
          verification: '检查 JSON-LD、rel=next/prev 和普通分页 href 后重新扫描。',
        };
      }
      const paginationLinks = snapshot.links.filter((link) => {
        return (
          link.rel.includes('next') ||
          link.rel.includes('prev') ||
          /(?:[?&](?:page|p)=\d+|\/page\/\d+)/i.test(link.href)
        );
      });
      if (paginationLinks.length === 0) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: '分类页没有检测到可抓取分页链接。',
          impact: '只通过无限滚动加载的后续内容可能缺少普通发现路径。',
          explanation: '列表页应让脚本失败时仍能通过链接翻页。',
          recommendation: '输出真实 href 的分页或“下一页”链接，再用 JavaScript 增强体验。',
          verification: '禁用 JavaScript 后从第一页导航到后续列表。',
          owner: '开发',
        };
      }
      return {
        status: 'pass',
        evidence: `检测到 ${paginationLinks.length} 个分页候选链接。`,
        impact: '后续列表具备普通发现入口。',
        explanation: '页面包含可抓取的分页 URL。',
        recommendation: '确保分页页状态、canonical 和内容各自正确。',
        verification: '逐页检查状态和重复关系。',
        owner: '开发',
        locator: firstLocator(paginationLinks),
      };
    },
  },
];
