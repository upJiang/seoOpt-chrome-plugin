import type {
  AuditCategory,
  AuditContext,
  AuditFinding,
  AuditPriority,
  AuditStatus,
  ElementLocator,
  PageSnapshot,
} from '../types';

export interface FindingInput {
  status: AuditStatus;
  priority?: AuditPriority;
  evidence: string;
  impact: string;
  explanation: string;
  recommendation: string;
  verification: string;
  observationPeriod?: string | undefined;
  effort?: AuditFinding['effort'] | undefined;
  owner?: AuditFinding['owner'] | undefined;
  rollback?: string | undefined;
  antiPattern?: string | undefined;
  limitations?: string | undefined;
  codeExample?: string | undefined;
  locator?: ElementLocator | undefined;
  scoreRatio?: number | null | undefined;
  includedInScore?: boolean;
  scoreCap?: number | undefined;
  scope?: AuditFinding['scope'];
  evidenceSource?: AuditFinding['evidenceSource'];
  confidence?: AuditFinding['confidence'];
  rootCauseId?: string;
  affectedUrls?: string[];
}

export interface AuditRule {
  id: string;
  title: string;
  category: AuditCategory;
  points: number;
  run: (snapshot: PageSnapshot, context: AuditContext) => FindingInput;
}

function defaultScoreRatio(status: AuditStatus): number | null {
  if (status === 'pass') return 1;
  if (status === 'warning') return 0.5;
  if (status === 'failure') return 0;
  return null;
}

function inferredRootCause(ruleId: string): string {
  if (/metadata\.title/.test(ruleId)) return 'metadata-title-template';
  if (/metadata\.description/.test(ruleId)) return 'metadata-description-template';
  if (/media\.image-dimensions|performance\.cls/.test(ruleId)) return 'layout-stability';
  if (/media\.loading-priority|performance\.lcp|performance\.fcp/.test(ruleId)) return 'critical-rendering-path';
  if (/links\.(valid-hrefs|anchor-text|internal-entry)/.test(ruleId)) return 'link-template';
  return ruleId;
}

function inferredEvidenceSource(ruleId: string): AuditFinding['evidenceSource'] {
  if (/response/.test(ruleId)) return 'http_response';
  if (/robots/.test(ruleId)) return 'robots';
  if (/sitemap/.test(ruleId)) return 'sitemap';
  if (/raw-render/.test(ruleId)) return 'raw_html';
  return 'rendered_dom';
}

export function findingFromRule(rule: AuditRule, input: FindingInput): AuditFinding {
  return {
    id: `${rule.id}:${crypto.randomUUID()}`,
    ruleId: rule.id,
    category: rule.category,
    title: rule.title,
    status: input.status,
    priority: input.priority ?? 'P3',
    points: rule.points,
    scoreRatio: input.scoreRatio === undefined ? defaultScoreRatio(input.status) : input.scoreRatio,
    includedInScore: input.includedInScore ?? rule.points > 0,
    evidence: input.evidence,
    impact: input.impact,
    explanation: input.explanation,
    recommendation: input.recommendation,
    verification: input.verification,
    observationPeriod: input.observationPeriod ?? '修改后立即复查页面输出；搜索结果变化需等待重新抓取。',
    effort: input.effort ?? '低',
    owner: input.owner ?? 'SEO',
    rollback: input.rollback ?? '恢复修改前的页面模板或配置，并重新扫描确认。',
    ...(input.antiPattern === undefined ? {} : { antiPattern: input.antiPattern }),
    ...(input.limitations === undefined ? {} : { limitations: input.limitations }),
    scope: input.scope ?? 'page',
    evidenceSource: input.evidenceSource ?? inferredEvidenceSource(rule.id),
    confidence: input.confidence ?? 'high',
    rootCauseId: input.rootCauseId ?? inferredRootCause(rule.id),
    affectedUrls: input.affectedUrls ?? [],
    ...(input.scoreCap === undefined ? {} : { scoreCap: input.scoreCap }),
    ...(input.codeExample === undefined ? {} : { codeExample: input.codeExample }),
    ...(input.locator === undefined ? {} : { locator: input.locator }),
  };
}

export function firstLocator<T extends { locator: ElementLocator }>(items: T[]): ElementLocator | undefined {
  return items[0]?.locator;
}

export function normalizeUrl(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export function comparableUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/$/, '');
    return url.href;
  } catch {
    return value;
  }
}

export function displayUnits(value: string): number {
  return [...value.trim()].reduce((total, character) => {
    return total + (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(character) ? 2 : 1);
  }, 0);
}
