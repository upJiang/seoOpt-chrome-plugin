import type { AuditRule } from './helpers';
import { displayUnits, firstLocator } from './helpers';

export const metadataRules: AuditRule[] = [
  {
    id: 'metadata.title',
    title: '页面标题',
    category: 'metadata',
    points: 7,
    run(snapshot) {
      const titles = snapshot.titleTags.map((title) => title.trim()).filter(Boolean);
      if (titles.length === 0) {
        return {
          status: 'failure',
          priority: 'P1',
          evidence: '最终 DOM 中没有非空 title。',
          impact: '搜索结果和浏览器无法获得清晰的页面主题。',
          explanation: 'title 是页面主题和搜索结果标题的重要来源。',
          recommendation: '输出一个能说明主题、对象和差异的唯一 title。',
          verification: '查看原始 HTML 和渲染 DOM，确认只有一个非空 title。',
          owner: '内容',
          codeExample: '<title>核心主题 - 适用场景与差异</title>',
        };
      }
      if (snapshot.titleTags.length > 1) {
        return {
          status: 'warning',
          priority: 'P1',
          evidence: `检测到 ${snapshot.titleTags.length} 个 title 标签。`,
          impact: '模板输出存在歧义，抓取结果可能不稳定。',
          explanation: '一个文档只应有一个明确标题。',
          recommendation: '排查服务端模板与客户端元信息组件的重复输出。',
          verification: '比较原始 HTML 和渲染 DOM 的 title 数量。',
          owner: '开发',
        };
      }
      return {
        status: 'pass',
        evidence: titles[0]!,
        impact: '页面具备明确标题。',
        explanation: '最终 DOM 中存在一个非空 title。',
        recommendation: '结合真实查询和 CTR 持续验证标题承诺。',
        verification: '修改后保留版本与日期，并观察搜索结果实际展示。',
        owner: '内容',
      };
    },
  },
  {
    id: 'metadata.title-risk',
    title: '标题展示风险',
    category: 'metadata',
    points: 3,
    run(snapshot) {
      const title = snapshot.titleTags.find((value) => value.trim())?.trim() ?? '';
      if (!title) {
        return {
          status: 'not_applicable',
          evidence: '没有可评估的标题。',
          impact: '标题完整性规则已单独报告。',
          explanation: '避免对同一缺失问题重复扣分。',
          recommendation: '先补充标题。',
          verification: '补充后重新扫描。',
        };
      }
      const units = displayUnits(title);
      if (units < 10 || units > 120) {
        const reasons = [
          units < 10 ? '信息量很少' : '',
          units > 120 ? '可能在搜索结果中被截断或改写' : '',
        ].filter(Boolean);
        return {
          status: 'warning',
          priority: 'P2',
          evidence: `标题视觉单位约 ${units}；${reasons.join('；')}。`,
          impact: '用户可能无法快速判断页面与查询的关系。',
          explanation: '搜索结果展示没有固定字符上限，此处只是基于信息量的风险提示。',
          recommendation: '把核心主题放在前部，补充对象或差异，避免口号和近义词堆叠。',
          verification: '以真实搜索结果、查询拆分和 CTR 作为最终判断。',
          owner: '内容',
        };
      }
      return {
        status: 'pass',
        evidence: `标题视觉单位约 ${units}。`,
        impact: '标题信息量处于可读范围。',
        explanation: '当前未发现明显过短或过长风险；与真实查询的匹配仍需搜索表现数据验证。',
        recommendation: '不要只为工具分数改写，继续用真实 CTR 验证。',
        verification: '按查询、设备和时间观察搜索结果展示。',
        owner: '内容',
      };
    },
  },
  {
    id: 'metadata.description',
    title: '页面描述',
    category: 'metadata',
    points: 6,
    run(snapshot) {
      const descriptions = snapshot.descriptions.map((value) => value.trim()).filter(Boolean);
      if (descriptions.length === 0) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: '没有非空 meta description。',
          impact: '搜索结果缺少可控的页面摘要候选。',
          explanation: '描述不保证原样展示，也不直接替代内容，但能降低点击疑虑。',
          recommendation: '写一段说明页面解决什么、适合谁以及下一步能获得什么的描述。',
          verification: '查看最终 HTML，并观察搜索结果是否采用或改写。',
          owner: '内容',
          codeExample: '<meta name="description" content="说明页面任务、适用对象和真实价值。">',
        };
      }
      if (snapshot.descriptions.length > 1) {
        return {
          status: 'warning',
          priority: 'P1',
          evidence: `检测到 ${snapshot.descriptions.length} 个 description。`,
          impact: '模板输出不唯一，摘要来源不明确。',
          explanation: '服务端与客户端元信息组件可能重复写入。',
          recommendation: '只保留一个与当前页面一致的描述。',
          verification: '比较原始 HTML 和渲染 DOM。',
          owner: '开发',
        };
      }
      return {
        status: 'pass',
        evidence: descriptions[0]!,
        impact: '页面具备一个明确摘要候选。',
        explanation: '最终 DOM 中存在一个非空描述。',
        recommendation: '确保描述承诺能被正文兑现。',
        verification: '结合实际展示和点击质量验证。',
        owner: '内容',
      };
    },
  },
  {
    id: 'metadata.description-risk',
    title: '描述信息质量',
    category: 'metadata',
    points: 3,
    run(snapshot) {
      const description = snapshot.descriptions.find((value) => value.trim())?.trim() ?? '';
      if (!description) {
        return {
          status: 'not_applicable',
          evidence: '没有可评估的描述。',
          impact: '缺失已在上一规则报告。',
          explanation: '避免重复扣分。',
          recommendation: '先补充描述。',
          verification: '补充后重新扫描。',
        };
      }
      const title = snapshot.titleTags.find((value) => value.trim())?.trim() ?? '';
      const units = displayUnits(description);
      const duplicatesTitle = Boolean(title) && description === title;
      if (units < 40 || units > 320 || duplicatesTitle) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: `描述视觉单位约 ${units}${duplicatesTitle ? '，且与标题完全相同' : ''}。`,
          impact: '摘要可能信息不足、冗长或无法补充标题。',
          explanation: '此处是展示风险，不是搜索引擎固定字符限制。',
          recommendation: '用自然语言补充适用对象、页面价值和边界，不重复标题或堆词。',
          verification: '检查搜索结果真实摘要与目标查询点击质量。',
          owner: '内容',
        };
      }
      return {
        status: 'pass',
        evidence: `描述视觉单位约 ${units}，且未照抄标题。`,
        impact: '描述具备补充页面承诺的空间。',
        explanation: '没有发现明显信息量或重复风险。',
        recommendation: '继续确认正文能够兑现描述。',
        verification: '观察实际摘要、CTR 和到站行为。',
        owner: '内容',
      };
    },
  },
  {
    id: 'metadata.h1',
    title: '页面主标题 H1',
    category: 'metadata',
    points: 6,
    run(snapshot) {
      const h1s = snapshot.headings.filter((heading) => heading.level === 1 && heading.text.trim());
      if (h1s.length === 0) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: '页面没有非空 H1。',
          impact: '用户和搜索系统缺少页面主任务的清晰确认。',
          explanation: 'H1 不是单独的排名开关，但应表达页面唯一主任务。',
          recommendation: '增加一个可见 H1，并让它与 title 和正文承诺一致。',
          verification: '查看可见页面和最终 DOM，确认 H1 可访问。',
          owner: '内容',
          codeExample: '<h1>当前页面唯一的主任务</h1>',
        };
      }
      if (h1s.length > 1) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: `${h1s.length} 个非空 H1。`,
          impact: '页面主任务可能不够集中。',
          explanation: '多个 H1 在现代 HTML 中并非语法错误，但专业页面应降低主标题歧义。',
          recommendation: '保留一个主要 H1，其余章节使用 H2/H3；不要强行堆叠目标词。',
          verification: '检查标题层级和真实用户阅读顺序。',
          owner: '内容',
          locator: firstLocator(h1s),
        };
      }
      return {
        status: 'pass',
        evidence: h1s[0]!.text,
        impact: '页面主任务清晰。',
        explanation: '页面存在一个非空 H1。',
        recommendation: '确保正文第一部分及时兑现该承诺。',
        verification: '对照 title、H1、开头和转化动作。',
        owner: '内容',
        locator: h1s[0]!.locator,
      };
    },
  },
];
