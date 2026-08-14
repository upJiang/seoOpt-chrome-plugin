import type { AuditRule } from './helpers';

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
}

function queryTerms(value: string): string[] {
  const normalized = normalize(value);
  if (!normalized) return [];
  const latin = normalized.split(' ').filter((term) => term.length >= 2);
  const han = [...normalized.matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap((match) => {
    const token = match[0];
    if (token.length <= 4) return [token];
    return [token, ...Array.from({ length: token.length - 1 }, (_, index) => token.slice(index, index + 2))];
  });
  return [...new Set([...latin, ...han])];
}

function overlap(query: string, value: string): number {
  const terms = queryTerms(query);
  if (!terms.length) return 0;
  const target = normalize(value);
  return terms.filter((term) => target.includes(term)).length / terms.length;
}

export const queryRules: AuditRule[] = [
  {
    id: 'metadata.query-alignment',
    title: '目标查询与页面任务一致性',
    category: 'metadata',
    points: 0,
    run(snapshot, context) {
      const query = context.targetQuery.trim();
      if (!query) {
        return {
          status: 'informational',
          evidence: '当前没有可靠的查询级搜索数据，插件未假定目标关键词。',
          impact: '无法确认某个具体查询是否由当前页面承载，但不影响其他页面检查。',
          explanation: '插件不会要求先填写关键词，也不会用关键词密度代替搜索意图判断。',
          recommendation: '保留为数据边界；如果以后导入搜索表现，只用真实产生展现的查询核对页面承诺。',
          verification: '使用查询、页面、展现、点击与有效业务结果确认，不依赖人工猜测关键词。',
          confidence: 'low',
        };
      }
      const title = snapshot.titleTags.find((value) => value.trim()) ?? '';
      const h1 = snapshot.headings.find((heading) => heading.level === 1)?.text ?? '';
      const task = context.pageTask.trim();
      const titleOverlap = overlap(query, title);
      const h1Overlap = overlap(query, h1);
      const taskOverlap = task ? overlap(query, task) : 0;
      if (Math.max(titleOverlap, h1Overlap, taskOverlap) < 0.35) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: `目标查询“${query}”与 title、H1、页面任务的表达重合较低。`,
          impact: '搜索用户可能难以判断页面是否能解决其问题。',
          explanation: '这不是关键词密度检查，而是页面承诺与搜索意图的人工复核提醒。',
          recommendation: '确认该页面是否真应承载此查询；若是，用自然语言在 title、H1 和首屏明确对象、任务与差异。',
          verification: '结合该查询的展现、CTR、到站行为和转化验证，不为工具分数重复堆词。',
          scoreRatio: null,
          confidence: 'medium',
          rootCauseId: 'search-intent-alignment',
        };
      }
      return {
        status: 'informational',
        evidence: `目标查询“${query}”与 title、H1 或页面任务存在可识别的语义交集。`,
        impact: '页面承诺具备基础一致性，实际相关性仍取决于内容是否兑现。',
        explanation: '本检查不要求完整词组机械重复。',
        recommendation: '保持自然表达，并用真实搜索表现和转化验证。',
        verification: '观察非品牌查询的展现、点击和有效转化。',
        confidence: 'medium',
        rootCauseId: 'search-intent-alignment',
      };
    },
  },
  {
    id: 'content.page-value',
    title: '页面承诺与实际价值',
    category: 'content',
    points: 0,
    run(snapshot, context) {
      if (context.expectedIndexState === 'noindex' || context.pageType === 'internal_app') {
        return {
          status: 'not_applicable',
          evidence: '当前页面不按公开搜索增长页评估。',
          impact: '登录后页面和明确不索引页面不需要套用搜索落地页标准。',
          explanation: '页面价值判断必须服从真实页面用途。',
          recommendation: '改用产品可用性与任务完成率验证。',
          verification: '检查真实用户能否完成核心操作。',
        };
      }
      const pageType = context.pageType === 'auto' ? 'unknown' : context.pageType;
      const title = snapshot.titleTags.find((value) => value.trim()) ?? '';
      const h1 = snapshot.headings.find((heading) => heading.level === 1)?.text ?? '';
      const promiseClear = Boolean(title.trim() && h1.trim());
      const hasAction = snapshot.formCount > 0 || snapshot.ctaTexts.some((value) => value.trim().length > 1);
      const hasResponsibility = snapshot.articleAuthorPresent
        || snapshot.articleDatePresent
        || snapshot.jsonLd.some((item) => item.types.some((type) => /organization|person|article|product|service/i.test(type)));
      const hasUsefulConnection = snapshot.links.some((link) => link.isInternal && link.accessibleName.trim().length > 1);
      const signals = [promiseClear, hasAction, hasResponsibility, hasUsefulConnection];
      const missing = [
        ...(!promiseClear ? ['页面主题与首屏承诺'] : []),
        ...(!hasAction && ['home', 'product_service', 'tool'].includes(pageType) ? ['合理的业务或任务入口'] : []),
        ...(!hasResponsibility && ['home', 'article', 'product_service'].includes(pageType) ? ['主体、作者或事实责任证据'] : []),
        ...(!hasUsefulConnection ? ['与当前任务有关的站内连接'] : []),
      ];
      if (missing.length >= 2 && signals.filter(Boolean).length <= 2) {
        return {
          status: 'warning',
          priority: 'P2',
          scoreRatio: null,
          includedInScore: false,
          evidence: `页面类型候选为${pageType === 'unknown' ? '尚未确定' : pageType}；当前缺少：${missing.join('、')}。`,
          impact: '即使技术标签正确，用户仍可能无法判断页面解决什么、证据来自谁，以及如何继续完成任务。',
          explanation: '搜索意图不仅是词语重合，还包括清楚承诺、任务信息、独有证据、责任主体和合理业务连接。',
          recommendation: pageType === 'article'
            ? '围绕核心问题先给清楚答案，再补充来源、作者或审核责任、适用条件、更新时间和相关内容连接。'
            : pageType === 'product_service'
              ? '说明适用对象、解决的问题、差异、真实证据、限制以及咨询或购买路径。'
              : pageType === 'tool'
                ? '解释工具用途、输入输出、示例、限制和可索引的结果说明，不只留下一个操作框。'
                : pageType === 'home'
                  ? '说明品牌主体、核心业务、适用对象、主要入口和可验证的实体信息。'
                  : '先明确页面类型和用户任务，再补齐承诺、证据、限制与自然的站内连接。',
          verification: '请目标用户只看页面首屏和主要内容，复述它解决什么、适合谁、依据是什么以及能够完成什么。',
          confidence: pageType === 'unknown' ? 'low' : 'medium',
          rootCauseId: 'page-value-delivery',
        };
      }
      return {
        status: 'informational',
        evidence: `已观察到页面主题、任务入口、责任证据或站内连接中的 ${signals.filter(Boolean).length} 类信号。`,
        impact: '页面具备进一步人工判断搜索价值的基础。',
        explanation: '插件只能确认结构证据，不能仅凭 DOM 判断内容是否独有、准确或真正有用。',
        recommendation: '保持页面承诺与真实能力一致，再用搜索表现和有效业务验证。',
        verification: '结合真实用户反馈、查询表现与有效转化确认。',
        confidence: 'low',
        rootCauseId: 'page-value-delivery',
      };
    },
  },
];
