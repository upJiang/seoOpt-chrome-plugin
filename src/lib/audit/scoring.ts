import {
  CATEGORY_CONFIG,
  type AuditCategory,
  type AuditFinding,
  type CategoryScore,
} from './types';

const EXCLUDED_STATUSES = new Set(['informational', 'not_measurable', 'not_applicable']);

function scoreBand(score: number | null): string {
  if (score === null) return '证据不足';
  if (score >= 90) return '优秀';
  if (score >= 75) return '良好';
  if (score >= 50) return '待优化';
  return '高风险';
}

export function calculateScores(findings: AuditFinding[]): {
  overallScore: number | null;
  scoreLabel: string;
  coverage: number;
  measuredChecks: number;
  measurableChecks: number;
  categoryScores: CategoryScore[];
} {
  const categoryScores = (Object.keys(CATEGORY_CONFIG) as AuditCategory[]).map((category) => {
    const categoryFindings = findings.filter((finding) => finding.category === category);
    const applicable = categoryFindings.filter((finding) => !EXCLUDED_STATUSES.has(finding.status));
    const earnedPoints = applicable.reduce(
      (total, finding) => total + finding.points * (finding.scoreRatio ?? 0),
      0,
    );
    const applicablePoints = applicable.reduce((total, finding) => total + finding.points, 0);
    const score = applicablePoints > 0 ? Math.round((earnedPoints / applicablePoints) * 100) : null;

    return {
      category,
      label: CATEGORY_CONFIG[category].label,
      score,
      earnedPoints,
      applicablePoints,
      configuredPoints: CATEGORY_CONFIG[category].points,
      issueCount: categoryFindings.filter(
        (finding) => finding.status === 'failure' || finding.status === 'warning',
      ).length,
    };
  });

  const measured = findings.filter((finding) => !EXCLUDED_STATUSES.has(finding.status));
  const measurable = findings.filter((finding) => finding.status !== 'not_applicable');
  const earned = measured.reduce(
    (total, finding) => total + finding.points * (finding.scoreRatio ?? 0),
    0,
  );
  const possible = measured.reduce((total, finding) => total + finding.points, 0);
  let overallScore = possible > 0 ? Math.round((earned / possible) * 100) : null;

  const caps = measured
    .filter((finding) => finding.status === 'failure' && finding.scoreCap !== undefined)
    .map((finding) => finding.scoreCap!);
  if (overallScore !== null && caps.length > 0) overallScore = Math.min(overallScore, ...caps);

  const coverage = measurable.length > 0 ? Math.round((measured.length / measurable.length) * 100) : 0;

  return {
    overallScore,
    scoreLabel: coverage < 60 ? '证据不足' : scoreBand(overallScore),
    coverage,
    measuredChecks: measured.length,
    measurableChecks: measurable.length,
    categoryScores,
  };
}
