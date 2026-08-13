import type { AuditFinding, AuditReport } from './types';

export interface ScoredFindingDetail {
  finding: AuditFinding;
  earnedPoints: number;
  possiblePoints: number;
  deductedPoints: number;
}

export interface ScoreCapDetail {
  finding: AuditFinding;
  cap: number;
}

export interface ScoreDetails {
  earnedPoints: number;
  possiblePoints: number;
  deductedPoints: number;
  normalizedScore: number | null;
  passed: ScoredFindingDetail[];
  deducted: ScoredFindingDetail[];
  caps: ScoreCapDetail[];
}

function roundPoint(value: number): number {
  return Math.round(value * 10) / 10;
}

export function buildScoreDetails(report: AuditReport): ScoreDetails {
  const scored = report.findings
    .filter((finding) => finding.points > 0 && finding.scoreRatio !== null)
    .map((finding) => {
      const earnedPoints = roundPoint(finding.points * (finding.scoreRatio ?? 0));
      return {
        finding,
        earnedPoints,
        possiblePoints: finding.points,
        deductedPoints: roundPoint(finding.points - earnedPoints),
      };
    });
  const earnedPoints = roundPoint(scored.reduce((total, item) => total + item.earnedPoints, 0));
  const possiblePoints = roundPoint(scored.reduce((total, item) => total + item.possiblePoints, 0));
  const deductedPoints = roundPoint(possiblePoints - earnedPoints);
  const caps = report.findings
    .filter((finding) => finding.status === 'failure' && finding.scoreCap !== undefined)
    .map((finding) => ({ finding, cap: finding.scoreCap! }))
    .sort((a, b) => a.cap - b.cap);

  return {
    earnedPoints,
    possiblePoints,
    deductedPoints,
    normalizedScore: possiblePoints > 0 ? Math.round((earnedPoints / possiblePoints) * 100) : null,
    passed: scored.filter((item) => item.earnedPoints > 0),
    deducted: scored
      .filter((item) => item.deductedPoints > 0)
      .sort((a, b) => b.deductedPoints - a.deductedPoints),
    caps,
  };
}
