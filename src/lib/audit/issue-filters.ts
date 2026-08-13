import type {
  AuditCategory,
  AuditFinding,
  AuditPriority,
  AuditStatus,
} from './types';

export type IssueStatusFilter = 'actionable' | AuditStatus | 'all';

export interface IssueFilters {
  priority: AuditPriority | 'all';
  category: AuditCategory | 'all';
  status: IssueStatusFilter;
}

export function matchesIssueStatus(finding: AuditFinding, status: IssueStatusFilter): boolean {
  if (status === 'all') return true;
  if (status === 'actionable') return finding.status === 'failure' || finding.status === 'warning';
  return finding.status === status;
}

export function filterIssueFindings(
  findings: AuditFinding[],
  filters: IssueFilters,
): AuditFinding[] {
  return findings
    .filter((finding) => filters.priority === 'all' || finding.priority === filters.priority)
    .filter((finding) => filters.category === 'all' || finding.category === filters.category)
    .filter((finding) => matchesIssueStatus(finding, filters.status));
}

export function countIssueCategories(
  findings: AuditFinding[],
  priority: AuditPriority | 'all',
  status: IssueStatusFilter,
): Record<AuditCategory | 'all', number> {
  const visible = filterIssueFindings(findings, { priority, category: 'all', status });
  const counts: Record<AuditCategory | 'all', number> = {
    all: visible.length,
    discoverability: 0,
    metadata: 0,
    content: 0,
    links: 0,
    media: 0,
    performance: 0,
  };

  for (const finding of visible) counts[finding.category] += 1;
  return counts;
}
