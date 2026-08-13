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
          evidence: '尚未填写目标查询。',
          impact: '无法从页面证据判断搜索意图与页面任务是否一致。',
          explanation: '目标查询用于解释页面承诺，不进入页面 SEO 基础分。',
          recommendation: '在概览填写一个真实用户会搜索的核心问题或需求。',
          verification: '对照搜索表现数据确认该查询确实产生展现和目标用户。',
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
];
