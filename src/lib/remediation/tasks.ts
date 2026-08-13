import type { AuditFinding, AuditPriority, AuditReport } from '../audit/types';
import type { AuditBaseline, RemediationTask, SiteAuditIssue } from '../projects/types';

const PRIORITY_ORDER: Record<AuditPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const CONFIDENCE_ORDER = { high: 0, medium: 1, low: 2 } as const;

function taskFromFinding(projectId: string, finding: AuditFinding, existing?: RemediationTask): RemediationTask {
  const now = new Date().toISOString();
  return {
    id: existing?.id || crypto.randomUUID(),
    projectId,
    rootCauseId: finding.rootCauseId || finding.ruleId,
    title: finding.title,
    status: existing?.status || 'todo',
    priority: finding.priority,
    confidence: finding.confidence,
    owner: finding.owner,
    effort: finding.effort,
    evidence: finding.evidence,
    why: finding.impact || finding.explanation,
    action: finding.recommendation,
    ...(finding.codeExample ? { codeExample: finding.codeExample } : {}),
    ...(finding.antiPattern ? { antiPattern: finding.antiPattern } : {}),
    ...(finding.limitations ? { limitations: finding.limitations } : {}),
    affectedUrls: [...new Set(finding.affectedUrls)],
    verification: finding.verification,
    observationPeriod: finding.observationPeriod,
    rollback: finding.rollback,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    ...(existing?.lastVerifiedAt ? { lastVerifiedAt: existing.lastVerifiedAt } : {}),
    ...(existing?.baselineId ? { baselineId: existing.baselineId } : {}),
  };
}

export function sortRemediationTasks(tasks: RemediationTask[]): RemediationTask[] {
  return [...tasks].sort((left, right) => {
    const priority = (PRIORITY_ORDER[left.priority] ?? 9) - (PRIORITY_ORDER[right.priority] ?? 9);
    if (priority) return priority;
    const confidence = CONFIDENCE_ORDER[left.confidence] - CONFIDENCE_ORDER[right.confidence];
    if (confidence) return confidence;
    if (left.affectedUrls.length !== right.affectedUrls.length) return right.affectedUrls.length - left.affectedUrls.length;
    return left.effort.localeCompare(right.effort, 'zh-CN');
  });
}

export function tasksFromFindings(projectId: string, findings: AuditFinding[], existing: RemediationTask[] = []): RemediationTask[] {
  const byRootCause = new Map(existing.map((task) => [task.rootCauseId, task]));
  const grouped = new Map<string, AuditFinding[]>();
  for (const finding of findings.filter((item) => item.status === 'failure' || item.status === 'warning')) {
    const rootCause = finding.rootCauseId || finding.ruleId;
    grouped.set(rootCause, [...(grouped.get(rootCause) || []), finding]);
  }
  const tasks = [...grouped.entries()].map(([rootCause, group]) => {
    const first = group.reduce((best, item) => (PRIORITY_ORDER[item.priority] < PRIORITY_ORDER[best.priority] ? item : best));
    const combined = group.length === 1 ? first : {
      ...first,
      title: `${first.title}（${group.length} 项规则）`,
      evidence: `${first.evidence} 同一根因还影响 ${group.length - 1} 项规则。`,
      affectedUrls: [...new Set(group.flatMap((item) => item.affectedUrls))],
    };
    return taskFromFinding(projectId, { ...combined, rootCauseId: rootCause }, byRootCause.get(rootCause));
  });
  return sortRemediationTasks(tasks);
}

export function tasksFromSiteIssues(projectId: string, issues: SiteAuditIssue[], existing: RemediationTask[] = []): RemediationTask[] {
  const byRootCause = new Map(existing.map((task) => [task.rootCauseId, task]));
  const now = new Date().toISOString();
  const tasks = issues.map((issue) => {
    const rootCauseId = `site:${issue.code}`;
    const old = byRootCause.get(rootCauseId);
    return {
      id: old?.id || crypto.randomUUID(),
      projectId,
      rootCauseId,
      title: issue.title,
      status: old?.status || 'todo',
      priority: issue.priority,
      confidence: issue.confidence,
      owner: issue.code.includes('schema') || issue.code.includes('content') ? '内容' : '开发',
      effort: issue.priority === 'P0' || issue.priority === 'P1' ? '中' : '低',
      evidence: issue.evidence,
      why: issue.impact || '这个问题可能同时影响多个页面。',
      action: issue.recommendation || '先按受影响 URL 和页面模板确认处理范围。',
      affectedUrls: [...new Set(issue.affectedUrls)],
      verification: issue.verification || '按相同范围重新运行站点审计。',
      observationPeriod: issue.priority === 'P0' || issue.priority === 'P1' ? '修复后立即复测；收录和排名另观察 2–4 周。' : '发布后观察 2–4 周。',
      rollback: '保留修改前模板、规则或 Sitemap 文件；异常时恢复上一版本并重新检查。',
      createdAt: old?.createdAt || now,
      updatedAt: now,
      ...(old?.lastVerifiedAt ? { lastVerifiedAt: old.lastVerifiedAt } : {}),
      ...(old?.baselineId ? { baselineId: old.baselineId } : {}),
    } satisfies RemediationTask;
  });
  return sortRemediationTasks(tasks);
}

export function baselineFromReport(projectId: string, report: AuditReport, siteRunId?: string, seoSummary: AuditBaseline['seoSummary'] = null): AuditBaseline {
  return {
    id: crypto.randomUUID(),
    projectId,
    reportId: report.id,
    ...(siteRunId ? { siteRunId } : {}),
    createdAt: report.createdAt,
    overallScore: report.overallScore,
    findingStates: Object.fromEntries(report.findings.map((finding) => [finding.ruleId, { status: finding.status, priority: finding.priority, evidence: finding.evidence }])),
    pageSignals: {
      url: report.url,
      status: report.snapshot.siteProbe.page.status,
      title: report.snapshot.titleTags[0] || null,
      description: report.snapshot.descriptions[0] || null,
      robots: report.snapshot.robotsMeta.join(', '),
      canonical: report.snapshot.canonicals[0] || null,
      h1Count: report.snapshot.headings.filter((heading) => heading.level === 1).length,
      visibleTextLength: report.snapshot.visibleTextLength,
    },
    siteIssueCount: 0,
    seoSummary,
  };
}

export interface BaselineDiff {
  score: { before: number | null; after: number | null; delta: number | null };
  fixedRules: string[];
  newRules: string[];
  changedRules: string[];
  pageSignals: Array<{ key: string; before: string | number | null | undefined; after: string | number | null | undefined }>;
}

export function diffBaselines(before: AuditBaseline | undefined, after: AuditBaseline): BaselineDiff {
  const beforeStates = before?.findingStates || {};
  const afterStates = after.findingStates;
  const fixedRules: string[] = [];
  const newRules: string[] = [];
  const changedRules: string[] = [];
  for (const ruleId of new Set([...Object.keys(beforeStates), ...Object.keys(afterStates)])) {
    const previous = beforeStates[ruleId];
    const current = afterStates[ruleId];
    if (!previous && current) newRules.push(ruleId);
    else if (previous && !current) fixedRules.push(ruleId);
    else if (previous && current && previous.status !== current.status) {
      if ((current.status === 'pass' || current.status === 'not_applicable') && previous.status !== current.status) fixedRules.push(ruleId);
      else changedRules.push(ruleId);
    }
  }
  const pageSignals = [...new Set([...Object.keys(before?.pageSignals || {}), ...Object.keys(after.pageSignals)])]
    .map((key) => ({ key, before: before?.pageSignals[key], after: after.pageSignals[key] }))
    .filter((item) => item.before !== item.after);
  return {
    score: { before: before?.overallScore ?? null, after: after.overallScore, delta: before?.overallScore != null && after.overallScore != null ? after.overallScore - before.overallScore : null },
    fixedRules,
    newRules,
    changedRules,
    pageSignals,
  };
}
