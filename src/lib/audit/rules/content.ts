import type { AuditRule } from './helpers';
import { firstLocator } from './helpers';

function inferredPageType(types: string[]): 'article' | 'product_service' | null {
  if (types.some((type) => /article|newsarticle|blogposting/i.test(type))) return 'article';
  if (types.some((type) => /product|service|softwareapplication/i.test(type))) return 'product_service';
  return null;
}

export const contentRules: AuditRule[] = [
  {
    id: 'content.heading-order',
    title: '标题层级',
    category: 'content',
    points: 4,
    run(snapshot) {
      const headings = snapshot.headings.filter((heading) => heading.text.trim());
      if (headings.length === 0) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: '没有检测到可见且非空的标题元素。',
          impact: '长内容缺少可扫描的问题分解。',
          explanation: '标题层级帮助用户和辅助技术理解阅读顺序。',
          recommendation: '用 H1 表达主任务，H2/H3 表达主要问题和细节。',
          verification: '按 DOM 顺序检查标题大纲。',
          owner: '内容',
        };
      }
      const skipped = headings.find((heading, index) => {
        const previous = headings[index - 1];
        return previous ? heading.level - previous.level > 1 : false;
      });
      if (skipped) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: `在“${skipped.text}”附近出现跨级标题。`,
          impact: '内容结构可能难以理解和导航。',
          explanation: '标题级别应表达嵌套关系，而不是仅用于视觉字号。',
          recommendation: '按内容关系调整标题级别，样式使用 CSS 控制。',
          verification: '重新生成标题大纲，确认层级连续且语义合理。',
          owner: '内容',
          locator: skipped.locator,
        };
      }
      return {
        status: 'pass',
        evidence: `检测到 ${headings.length} 个非空标题，未发现明显跨级。`,
        impact: '页面内容具备可扫描结构。',
        explanation: '标题顺序没有明显跳级。',
        recommendation: '继续让标题表达问题分解，而不是关键词列表。',
        verification: '改版后复核标题大纲。',
        owner: '内容',
        locator: firstLocator(headings),
      };
    },
  },
  {
    id: 'content.main-landmark',
    title: '主要内容语义区域',
    category: 'content',
    points: 3,
    run(snapshot) {
      if (snapshot.mainCount === 0) {
        return {
          status: 'warning',
          priority: 'P3',
          evidence: '没有 main 元素或 role="main"。',
          impact: '辅助技术和自动化工具较难快速定位主要内容。',
          explanation: 'main 是语义与可访问性信号，不是排名开关。',
          recommendation: '用一个 main 包裹当前页面唯一的主要内容。',
          verification: '检查页面仅存在一个可见主要内容区域。',
          owner: '开发',
          codeExample: '<main>页面主要内容</main>',
        };
      }
      if (snapshot.mainCount > 1) {
        return {
          status: 'warning',
          priority: 'P3',
          evidence: `检测到 ${snapshot.mainCount} 个 main 语义区域。`,
          impact: '主要内容边界存在歧义。',
          explanation: '一个文档通常应只有一个当前可见的 main。',
          recommendation: '保留一个主区域，其他容器使用 section、aside 或 div。',
          verification: '用辅助技术地标导航复核。',
          owner: '开发',
        };
      }
      return {
        status: 'pass',
        evidence: '检测到一个主要内容语义区域。',
        impact: '主要内容边界清晰。',
        explanation: '页面具备明确 main 地标。',
        recommendation: '保持导航、侧栏和主要内容职责分离。',
        verification: '组件改造后检查地标数量。',
        owner: '开发',
      };
    },
  },
  {
    id: 'content.language',
    title: '文档语言',
    category: 'content',
    points: 2,
    run(snapshot) {
      const valid = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(snapshot.htmlLang.trim());
      if (!valid) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: snapshot.htmlLang ? `html lang="${snapshot.htmlLang}" 无法识别。` : 'html 元素没有 lang。',
          impact: '语言识别、朗读和多语言处理可能不准确。',
          explanation: '文档语言应使用有效的 BCP 47 语言标记。',
          recommendation: '设置与页面主要语言一致的 lang，例如 zh-CN 或 en。',
          verification: '查看最终 HTML 的 html 元素。',
          owner: '开发',
          codeExample: '<html lang="zh-CN">',
        };
      }
      return {
        status: 'pass',
        evidence: `html lang="${snapshot.htmlLang}"。`,
        impact: '页面主要语言声明清晰。',
        explanation: '文档使用可识别的语言标记。',
        recommendation: '语言切换页应同步更新 lang 与 hreflang。',
        verification: '检查不同语言模板。',
        owner: '开发',
      };
    },
  },
  {
    id: 'content.visible-content',
    title: '主要可见内容',
    category: 'content',
    points: 4,
    run(snapshot, context) {
      if (context.expectedIndexState === 'noindex' || context.pageType === 'internal_app') {
        return {
          status: 'not_applicable',
          evidence: '当前扫描配置不要求页面参与公开搜索。',
          impact: '公开内容规模不参与评分。',
          explanation: '登录工具和不索引页面不应套用营销内容门槛。',
          recommendation: '仍需确保真实用户能够完成核心任务。',
          verification: '使用产品可用性测试而非搜索内容指标。',
        };
      }
      if (snapshot.visibleTextLength === 0) {
        return {
          status: 'failure',
          priority: 'P1',
          evidence: '渲染后的主要页面没有可见正文。',
          impact: '用户和搜索系统无法从当前页面获得完成任务所需的信息。',
          explanation: '这是空正文证据，不是固定字数检查。',
          recommendation: '恢复页面真实主要内容，并确认它在正常加载和脚本失败边界下仍可读取。',
          verification: '重新扫描并确认主要正文可见；同时检查原始 HTML 与渲染结果。',
          owner: '内容',
          confidence: 'high',
          rootCauseId: 'page-value-delivery',
        };
      }
      if (snapshot.visibleTextLength < 100) {
        return {
          status: 'warning',
          priority: 'P3',
          scoreRatio: null,
          includedInScore: false,
          evidence: `当前页面可见信息很少，约 ${snapshot.visibleTextLength} 个字符，仅列为人工复核候选。`,
          impact: '页面是否足以完成真实用户任务不能仅凭长度判断。',
          explanation: '不同页面所需信息不同；插件不会使用固定字数作为内容质量标准。',
          recommendation: '按页面类型核对是否已提供结论、适用条件、真实证据、限制和合理业务连接；信息已经足够时无需为工具扩写。',
          verification: '让目标用户仅凭该页完成预期判断，并结合相关查询和有效业务结果复核。',
          owner: '内容',
          confidence: 'low',
          rootCauseId: 'page-value-delivery',
        };
      }
      return {
        status: 'pass',
        evidence: `可见正文约 ${snapshot.visibleTextLength} 字符。`,
        impact: '页面具备独立表达的基础。',
        explanation: '未发现极端空白或仅有标题的情况。',
        recommendation: '内容质量仍需结合意图、证据和业务结果人工判断。',
        verification: '用查询、页面、转化和用户反馈验证。',
        owner: '内容',
      };
    },
  },
  {
    id: 'content.entity-signals',
    title: '作者与实体责任信息',
    category: 'content',
    points: 2,
    run(snapshot, context) {
      const schemaTypes = snapshot.jsonLd.flatMap((item) => item.types);
      const pageType = context.pageType === 'auto' ? inferredPageType(schemaTypes) : context.pageType;
      if (pageType !== 'article') {
        return {
          status: 'not_applicable',
          evidence: '当前页面未按文章类型评估作者与日期。',
          impact: '该条件不参与分数。',
          explanation: '不同页面类型需要不同责任信息。',
          recommendation: '服务或产品页仍应明确公司、品牌和联系主体。',
          verification: '人工检查页面真实责任主体。',
        };
      }
      if (!snapshot.articleAuthorPresent || !snapshot.articleDatePresent) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: `作者：${snapshot.articleAuthorPresent ? '有' : '缺失'}；日期：${snapshot.articleDatePresent ? '有' : '缺失'}。`,
          impact: '用户难以判断谁负责、内容何时有效。',
          explanation: '作者和更新时间应来自真实可验证的数据源。',
          recommendation: '展示真实作者或审核角色、发布时间、更新时间和适用范围。',
          verification: '确认可见内容与结构化数据一致。',
          owner: '内容',
        };
      }
      return {
        status: 'pass',
        evidence: '页面同时具备作者和日期信号。',
        impact: '文章责任主体和时效更易验证。',
        explanation: '可见页面包含基础作者与日期信息。',
        recommendation: '不要创建无法验证的专家身份或虚假更新时间。',
        verification: '抽样核对作者页、日期和实际修改记录。',
        owner: '内容',
      };
    },
  },
];
