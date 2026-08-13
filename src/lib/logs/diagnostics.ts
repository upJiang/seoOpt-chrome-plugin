import type { ServerLogSummary } from '../projects/types';

export interface ServerLogDiagnostic {
  code: string;
  priority: 'P1' | 'P2' | 'P3';
  title: string;
  evidence: string;
  action: string;
  verification: string;
}

export function diagnoseServerLog(summary: ServerLogSummary): ServerLogDiagnostic[] {
  const diagnostics: ServerLogDiagnostic[] = [];
  const errors = Object.entries(summary.statusCounts).filter(([status]) => Number(status) >= 400).reduce((sum, [, count]) => sum + count, 0);
  if (errors) diagnostics.push({
    code: 'log.error-status',
    priority: 'P1',
    title: '日志中存在错误状态请求',
    evidence: `${errors.toLocaleString()} 次请求返回 4xx/5xx。`,
    action: '按 URL 和状态码定位失效链接、改版遗漏和服务器错误；修复应保留页面，已删除页面从 Sitemap 和内链中移除。',
    verification: '下一周期重新导入聚合日志，确认错误请求量和受影响 URL 下降。',
  });
  if (summary.slowUrlCandidates.length) diagnostics.push({
    code: 'log.slow-url',
    priority: 'P2',
    title: '部分 URL 响应较慢',
    evidence: `${summary.slowUrlCandidates.length} 个 URL 达到慢请求阈值；日志没有提供真实用户 Core Web Vitals。`,
    action: '先检查这些 URL 的缓存命中、数据库查询和上游接口，再用浏览器性能指标验证用户可见速度。',
    verification: '比较同一 URL 的 p95 响应时间和页面 LCP/FCP，不把单一服务器耗时当成用户体验结论。',
  });
  if (summary.wastedUrlCandidates.length) diagnostics.push({
    code: 'log.parameter-waste',
    priority: 'P2',
    title: '参数 URL 存在重复抓取或错误请求候选',
    evidence: `${summary.wastedUrlCandidates.length} 个 URL 被标记为参数浪费或错误状态候选。`,
    action: '确认参数是否改变页面任务；无价值参数统一 Canonical/noindex 或在链接生成层消除，避免仅用 robots 隐藏已被发现地址。',
    verification: '观察爬虫请求中参数 URL 的比例，确认 Sitemap 和站内链接只输出规范地址。',
  });
  if (summary.sitemapNeverCrawledCandidates.length) diagnostics.push({
    code: 'log.sitemap-never-crawled',
    priority: 'P3',
    title: '页面清单中的地址尚未在样本日志中出现爬虫访问',
    evidence: `${summary.sitemapNeverCrawledCandidates.length} 个 Sitemap URL 在本次日志样本中没有疑似爬虫请求。User-Agent 只能作为疑似证据。`,
    action: '确认这些页面是否有站内链接和真实搜索价值；不要仅凭一次日志导入就断定搜索引擎没有抓取。',
    verification: '延长日志窗口并结合搜索平台抓取统计或服务器日志身份校验后再判断。',
  });
  return diagnostics;
}
