import { getProjectRows, getSitePages, latestLogSummary, latestOverseasReport, latestSemReport, latestSiteRun, listAuditBaselines, listChangeRecords, listDatasets, listRemediationTasks, listTrackingRuns } from './db';
import type { AnalyticsPerformanceRow, BusinessOutcomeRow, SearchProject, SemPerformanceRow, SeoPerformanceRow } from './types';
import { summarizeSeoPerformance } from '../seo/performance';
import { getSiteIssueDisplayTitle, getSiteIssueGuidance } from '../site-audit/guidance';

function percent(value: number): string { return `${(value * 100).toFixed(2)}%`; }

export async function buildProjectExport(project: SearchProject) {
  const [datasets, siteRun, seoRows, semRows, businessRows, analyticsRows, semReport, tasks, baselines, changes, logSummary, trackingRuns, overseasReport] = await Promise.all([
    listDatasets(project.id),
    latestSiteRun(project.id),
    getProjectRows<SeoPerformanceRow>('seo_performance', project.id),
    getProjectRows<SemPerformanceRow>('sem_performance', project.id),
    getProjectRows<BusinessOutcomeRow>('business_outcome', project.id),
    getProjectRows<AnalyticsPerformanceRow>('analytics_performance', project.id),
    latestSemReport(project.id),
    listRemediationTasks(project.id),
    listAuditBaselines(project.id),
    listChangeRecords(project.id),
    latestLogSummary(project.id),
    listTrackingRuns(project.id),
    latestOverseasReport(project.id),
  ]);
  const sitePages = siteRun ? await getSitePages(siteRun.id) : [];
  const seo = seoRows.length ? summarizeSeoPerformance(seoRows) : null;
  const semTotals = {
    impressions: semRows.reduce((sum, row) => sum + row.impressions, 0),
    clicks: semRows.reduce((sum, row) => sum + row.clicks, 0),
    cost: semRows.reduce((sum, row) => sum + row.cost, 0),
    platformConversions: semRows.reduce((sum, row) => sum + row.platformConversions, 0),
    validConversions: businessRows.reduce((sum, row) => sum + row.validConversions, 0),
    revenue: businessRows.reduce((sum, row) => sum + row.revenue, 0),
    refunds: businessRows.reduce((sum, row) => sum + row.refunds, 0),
    grossProfit: businessRows.reduce((sum, row) => sum + row.grossProfit, 0),
  };
  return {
    version: 3,
    generatedAt: new Date().toISOString(),
    project: {
      name: project.name,
      origin: project.origin,
      market: project.market,
      timezone: project.timezone,
      currency: project.currency,
      brandTerms: project.brandTerms,
      primaryConversion: project.primaryConversion,
      semBoundaries: project.sem,
      international: project.international ?? null,
    },
    datasets: datasets.map(({ id: _id, projectId: _projectId, fingerprint: _fingerprint, mapping: _mapping, ...dataset }) => dataset),
    site: siteRun ? {
      status: siteRun.status,
      sampledPages: sitePages.length,
      limit: siteRun.limit,
      blockedByRobots: siteRun.blockedUrls.length,
      issues: siteRun.issues.map((issue) => ({ ...issue, title: getSiteIssueDisplayTitle(issue), ...getSiteIssueGuidance(issue), affectedUrls: issue.affectedUrls.slice(0, 20) })),
      inventory: siteRun.inventory ? {
        ...siteRun.inventory,
        internalLinkOpportunities: siteRun.inventory.internalLinkOpportunities.slice(0, 20),
      } : null,
      technicalDelivery: {
        compressionAttention: sitePages.filter((page) => page.compressionStatus === 'attention').length,
        cacheAttention: sitePages.filter((page) => page.cacheStatus === 'attention').length,
        internalNofollowPages: sitePages.filter((page) => (page.nofollowInternalCount || 0) > 0 || page.pageNofollow).length,
        crawlerAttention: sitePages.filter((page) => page.crawlerAccessStatus === 'attention' || page.crawlerAccessStatus === 'confirm').length,
        robots: siteRun.robotsSummary || null,
        entryVariants: (siteRun.entryVariants || []).map((variant) => ({
          requestedUrl: variant.requestedUrl,
          finalUrl: variant.finalUrl,
          status: variant.status,
          redirectCount: variant.redirectCount,
          chainComplete: variant.chainComplete,
          error: variant.error,
        })),
        limitations: [
          '证书到期时间、证书链和 TLS 等级不在浏览器扩展可可靠读取的范围内。',
          '未使用 CSS/JavaScript 需要 Coverage 或代码依赖分析，当前只报告加载风险候选。',
          '匿名 GET 与 User-agent 规则不能证明请求来自真实搜索引擎。',
        ],
      },
    } : null,
    seo,
    sem: semReport ? { totals: semTotals, diagnosis: semReport } : { totals: semTotals, diagnosis: null },
    overseas: {
      analyticsRows: analyticsRows.length,
      trackingRuns: trackingRuns.slice(0, 20).map((run) => ({
        startedAt: run.startedAt, endedAt: run.endedAt, goal: run.goal, status: run.status,
        observationCount: run.observations.length, duplicateEvents: run.duplicateEvents,
        successfulActionObserved: Boolean(run.successfulActionObserved), failedActionObserved: Boolean(run.failedActionObserved),
        sensitiveFieldCandidateCount: run.sensitiveFieldNames.length, limitations: run.limitations,
      })),
      reconciliation: overseasReport ? {
        createdAt: overseasReport.createdAt, clicks: overseasReport.clicks, sessions: overseasReport.sessions,
        analyticsKeyEvents: overseasReport.analyticsKeyEvents, platformConversions: overseasReport.platformConversions,
        validConversions: overseasReport.validConversions, revenue: overseasReport.revenue, refunds: overseasReport.refunds,
        currency: overseasReport.currency, currencyComparable: overseasReport.currencyComparable,
        observedCurrencies: overseasReport.observedCurrencies, period: overseasReport.period,
        alignment: overseasReport.alignment, confidence: overseasReport.confidence,
        findings: overseasReport.findings.map(({ id: _id, ...finding }) => finding), gaps: overseasReport.gaps,
      } : null,
    },
    remediation: tasks.map(({ id: _id, projectId: _projectId, status: _status, ...task }) => ({ ...task, affectedUrls: task.affectedUrls.slice(0, 50) })),
    baselines: baselines.slice(0, 20).map(({ projectId: _projectId, findingStates: _findingStates, ...baseline }) => ({
      ...baseline,
      findingSummary: Object.values(_findingStates).reduce<Record<string, number>>((summary, finding) => ({ ...summary, [finding.status]: (summary[finding.status] || 0) + 1 }), {}),
    })),
    changes: changes.slice(0, 50).map(({ projectId: _projectId, ...change }) => change),
    serverLog: logSummary ? {
      importedAt: logSummary.importedAt,
      requestCount: logSummary.requestCount,
      dateMin: logSummary.dateMin,
      dateMax: logSummary.dateMax,
      botFamilies: logSummary.botFamilies,
      statusCounts: logSummary.statusCounts,
      slowUrlCandidates: logSummary.slowUrlCandidates,
      wastedUrlCandidates: logSummary.wastedUrlCandidates,
      sitemapNeverCrawledCandidates: logSummary.sitemapNeverCrawledCandidates,
      privacy: logSummary.privacy,
    } : null,
    privacy: '不包含原始 CSV、原始服务器日志、请求正文、表单值、Cookie、API Key、真实事件 ID、业务归因 ID 或业务记录明细。',
  };
}

export async function projectExportMarkdown(project: SearchProject): Promise<string> {
  const data = await buildProjectExport(project);
  const lines = [
    `# ${project.name} 搜索增长报告`, '',
    `- 主域名：${project.origin}`,
    `- 市场 / 时区 / 货币：${project.market} / ${project.timezone} / ${project.currency}`,
    `- 核心转化：${project.primaryConversion || '未设置'}`, '',
    '## 站点审计', '',
    data.site ? `采样 ${data.site.sampledPages}/${data.site.limit} 个 URL，发现 ${data.site.issues.length} 组问题。采样不代表全站。` : '尚无站点审计。', '',
  ];
  for (const issue of data.site?.issues ?? []) {
    lines.push(
      `### ${issue.priority} ${issue.title}`,
      '',
      `- 发现了什么：${issue.evidence}`,
      `- 为什么要处理：${issue.impact}`,
      `- 建议怎么做：${issue.recommendation}`,
      `- 怎么验证：${issue.verification}`,
      `- 受影响页面：${issue.affectedUrls.length} 个`,
      '',
    );
  }
  if (data.site?.technicalDelivery) {
    const technical = data.site.technicalDelivery;
    lines.push(
      '## 技术交付摘要',
      '',
      `- 未压缩文本页面候选：${technical.compressionAttention}`,
      `- 缓存风险候选：${technical.cacheAttention}`,
      `- 页面级或站内 nofollow 候选：${technical.internalNofollowPages}`,
      `- 匿名抓取需关注页面：${technical.crawlerAttention}`,
      `- 已保存入口检查：${technical.entryVariants.length} 个入口`,
      '',
      '### 检测限制',
      '',
      ...technical.limitations.map((item) => `- ${item}`),
      '',
    );
  }
  lines.push('', '## 优化清单', '');
  if (data.remediation.length) {
    for (const task of data.remediation) lines.push(
      `### ${task.priority} ${task.title}`,
      '',
      `- 负责人 / 工作量：${task.owner} / ${task.effort}`,
      `- 证据：${task.evidence}`,
      `- 修改：${task.action}`,
      ...(task.antiPattern ? [`- 不要这样修改：${task.antiPattern}`] : []),
      ...(task.limitations ? [`- 检测限制：${task.limitations}`] : []),
      `- 验证：${task.verification}`,
      `- 观察周期：${task.observationPeriod}`,
      `- 回滚：${task.rollback}`,
      '',
    );
  } else lines.push('尚无优化任务。');
  lines.push('', '## 修改前后基线', '');
  if (data.baselines.length) for (const baseline of data.baselines.slice(0, 5)) lines.push(`- ${baseline.createdAt}：页面 SEO 基础分 ${baseline.overallScore ?? '证据不足'}，站点问题 ${baseline.siteIssueCount}`);
  else lines.push('尚无复测基线。');
  lines.push('', '## 服务器日志摘要', '');
  if (data.serverLog) lines.push(`- 时间范围：${data.serverLog.dateMin ?? '未知'} 至 ${data.serverLog.dateMax ?? '未知'}`, `- 请求数：${data.serverLog.requestCount}`, `- 慢 URL 候选：${data.serverLog.slowUrlCandidates.length}`, `- 参数或错误浪费候选：${data.serverLog.wastedUrlCandidates.length}`);
  else lines.push('尚未导入服务器日志摘要。');
  lines.push('', '## SEO 搜索表现', '');
  if (data.seo) lines.push(`- 展现：${data.seo.impressions}`, `- 点击：${data.seo.clicks}`, `- CTR：${percent(data.seo.ctr)}`, `- 查询页面冲突候选：${data.seo.cannibalizationCandidates.length}`);
  else lines.push('尚无 SEO 搜索表现数据。');
  lines.push('', '## SEM 诊断', '', `- 成本：${data.sem.totals.cost}`, `- 平台转化：${data.sem.totals.platformConversions}`, `- 有效转化：${data.sem.totals.validConversions}`, `- 收入 / 退款 / 毛利：${data.sem.totals.revenue} / ${data.sem.totals.refunds} / ${data.sem.totals.grossProfit}`);
  for (const finding of data.sem.diagnosis?.findings ?? []) lines.push(`- ${finding.priority} ${finding.title}：${finding.action}`);
  lines.push('', '## 海外站优化', '', `- 目标地区 / 语言：${project.international?.targetCountry || '未设置'} / ${project.international?.targetLanguage || '未设置'}`, `- 脱敏追踪测试：${data.overseas.trackingRuns.length} 次`, `- GA4 规范化数据：${data.overseas.analyticsRows} 行`);
  if (data.overseas.reconciliation) {
    lines.push(
      `- 点击 → 会话 → 分析关键事件 → 平台转化 → 有效业务：${data.overseas.reconciliation.clicks} → ${data.overseas.reconciliation.sessions} → ${data.overseas.reconciliation.analyticsKeyEvents} → ${data.overseas.reconciliation.platformConversions} → ${data.overseas.reconciliation.validConversions}`,
      `- 对齐周期：${data.overseas.reconciliation.period.start || '无法对齐'} 至 ${data.overseas.reconciliation.period.end || '无法对齐'}（${data.overseas.reconciliation.period.timezone}，成熟期 ${data.overseas.reconciliation.period.maturityDays} 天）`,
      `- 归因置信度：点击 ID ${data.overseas.reconciliation.alignment.highConfidenceRows} 行；唯一 UTM ${data.overseas.reconciliation.alignment.mediumConfidenceRows} 行；系列+日期 ${data.overseas.reconciliation.alignment.lowConfidenceRows} 行；未匹配 ${data.overseas.reconciliation.alignment.unmatchedRows} 行`,
      `- 货币：${data.overseas.reconciliation.observedCurrencies.join('、') || '未提供'}；金额${data.overseas.reconciliation.currencyComparable ? '可在当前口径下比较' : '不可跨来源比较'}`,
      '',
    );
    for (const finding of data.overseas.reconciliation.findings) lines.push(`### ${finding.priority} ${finding.title}`, '', `- 证据：${finding.evidence}`, `- 为什么：${finding.why}`, `- 修改：${finding.action}`, `- 验证：${finding.verification}`, `- 平台确认：${finding.platformConfirmation}`, `- 回滚：${finding.rollback}`, `- 限制：${finding.limitation}`, '');
  } else lines.push('- 尚未运行海外三方数据核对。', '');
  lines.push('', '## 数据缺口', '', ...(data.sem.diagnosis?.dataGaps.map((gap) => `- ${gap}`) ?? ['- 尚未运行 SEM 诊断。']), ...(data.overseas.reconciliation?.gaps.map((gap) => `- ${gap}`) ?? []), '', data.privacy);
  return lines.join('\n');
}
