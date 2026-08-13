import { contentRules } from './content';
import { discoverabilityRules } from './discoverability';
import { linkRules } from './links';
import { mediaRules } from './media';
import { metadataRules } from './metadata';
import { performanceRules } from './performance';
import { queryRules } from './query';
import { technicalRules } from './technical';
import { findingFromRule, type AuditRule } from './helpers';
import { calculateScores } from '../scoring';
import type { AuditContext, AuditFinding, AuditReport, PageSnapshot } from '../types';

export const AUDIT_RULES: AuditRule[] = [
  ...discoverabilityRules,
  ...metadataRules,
  ...contentRules,
  ...linkRules,
  ...mediaRules,
  ...performanceRules,
  ...queryRules,
  ...technicalRules,
];

export const EXTERNAL_DATA_GAPS = [
  '实际索引状态需要搜索平台或 URL 检查数据',
  '关键词排名、展现与点击需要查询级搜索表现数据',
  '外链和站点权威需要站外链接数据',
  '全站重复标题、重复内容与孤立页需要站内爬取',
  '真实爬虫访问频率需要服务器日志',
  '真实用户 Core Web Vitals 需要字段数据',
  'INP 交互响应需要足够的真实用户交互样本',
  '搜索需求、转化质量与收入需要分析和业务系统',
];

export function inferAuditContext(snapshot: PageSnapshot): AuditContext {
  const schemaTypes = snapshot.jsonLd.flatMap((item) => item.types).map((type) => type.toLocaleLowerCase());
  let pageType: AuditContext['pageType'] = 'auto';

  if (schemaTypes.some((type) => /article|newsarticle|blogposting/.test(type))) {
    pageType = 'article';
  } else if (schemaTypes.some((type) => /product|service|softwareapplication|webapplication/.test(type))) {
    pageType = 'product_service';
  } else if (
    schemaTypes.some((type) => /collectionpage|itemlist|searchresultspage/.test(type))
    || snapshot.links.some((link) => link.rel.includes('next') || link.rel.includes('prev'))
  ) {
    pageType = 'category';
  }

  return {
    expectedIndexState: 'unknown',
    pageType,
    targetQuery: '',
    pageTask: '',
  };
}

export function buildAuditReport(
  snapshot: PageSnapshot,
  tabId: number,
  contextOverride?: Partial<AuditContext>,
): AuditReport {
  const context = { ...inferAuditContext(snapshot), ...contextOverride };
  const findings: AuditFinding[] = AUDIT_RULES.map((rule) => {
    const finding = findingFromRule(rule, rule.run(snapshot, context));
    return { ...finding, affectedUrls: finding.affectedUrls.length ? finding.affectedUrls : [snapshot.url] };
  });
  const scores = calculateScores(findings);
  const storedSnapshot: PageSnapshot = {
    ...snapshot,
    // A short visible-text sample is transient and only recollected after an explicit AI action.
    visibleTextPreview: '',
  };

  return {
    id: crypto.randomUUID(),
    tabId,
    url: snapshot.url,
    createdAt: new Date().toISOString(),
    context,
    overallScore: scores.overallScore,
    scoreLabel: scores.coverage < 60 ? '证据不足' : scores.scoreLabel,
    coverage: scores.coverage,
    measuredChecks: scores.measuredChecks,
    measurableChecks: scores.measurableChecks,
    categoryScores: scores.categoryScores,
    findings,
    externalDataGaps: EXTERNAL_DATA_GAPS,
    snapshot: storedSnapshot,
    stale: false,
  };
}
