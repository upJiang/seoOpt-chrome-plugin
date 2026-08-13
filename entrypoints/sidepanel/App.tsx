import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertCircle,
  ArrowRight,
  Braces,
  Check,
  ChevronDown,
  ChevronUp,
  CircleGauge,
  Code2,
  Copy,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileSearch,
  Filter,
  Focus,
  Globe2,
  Info,
  KeyRound,
  Lightbulb,
  ListFilter,
  LoaderCircle,
  MapPin,
  MessageCircle,
  MonitorCog,
  Megaphone,
  MousePointerClick,
  RefreshCw,
  ScanSearch,
  Save,
  Settings,
  ShieldAlert,
  Sparkles,
  Send,
  Square,
  Trash2,
  Zap,
  X,
} from 'lucide-react';
import {
  type ReactNode,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { normalizeAiEndpoint, permissionPatternForEndpoint } from '../../src/lib/ai-provider';
import { originPermissionPattern } from '../../src/lib/page-access';
import { buildScoreDetails } from '../../src/lib/audit/score-details';
import {
  countIssueCategories,
  filterIssueFindings,
  type IssueStatusFilter,
} from '../../src/lib/audit/issue-filters';
import { buildRecommendationSections, getExpectedOutcome, getFindingCodeAdvice, groupRecommendationsByRootCause } from '../../src/lib/audit/recommendations';
import { SeoGrowthSections } from './SeoGrowthSections';
import { clearAllProjectData, createProjectForOrigin, listAuditBaselines, listRemediationTasks, saveRemediationTask } from '../../src/lib/projects/db';
import { baselineFromReport, diffBaselines, tasksFromFindings } from '../../src/lib/remediation/tasks';
import type { AuditBaseline, RemediationTask } from '../../src/lib/projects/types';
import { SelectField } from './SelectField';
import {
  CATEGORY_CONFIG,
  DEFAULT_PREFERENCES,
  type AiChatEntry,
  type AiChatReply,
  type AiConversation,
  type AuditContext,
  type AuditCategory,
  type AuditFinding,
  type AuditPriority,
  type AuditReport,
  type AuditStatus,
  type RuntimeMessage,
  type ScanState,
  type TechnicalSignalStatus,
  type UserPreferences,
} from '../../src/lib/audit/types';

type ViewId = 'overview' | 'issues' | 'recommendations' | 'overseas' | 'ai' | 'sem';
type OverviewSection = 'summary' | 'page-info' | 'crawl-evidence' | 'site-audit';

interface RpcResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

const LazyAiMarkdown = lazy(() => import('./AiMarkdown'));
const LazyOverseasWorkspace = lazy(() => import('./OverseasWorkspace').then((module) => ({ default: module.OverseasWorkspace })));
const LazySemWorkspace = lazy(() => import('./SemWorkspace').then((module) => ({ default: module.SemWorkspace })));

const VIEW_ITEMS: Array<{ id: ViewId; label: string; shortLabel: string; icon: typeof CircleGauge }> = [
  { id: 'overview', label: '概览', shortLabel: '概览', icon: CircleGauge },
  { id: 'issues', label: '问题', shortLabel: '问题', icon: ListFilter },
  { id: 'recommendations', label: '优化建议', shortLabel: '建议', icon: Lightbulb },
  { id: 'overseas', label: '海外站优化', shortLabel: '海外', icon: Globe2 },
  { id: 'ai', label: 'AI 深度解读', shortLabel: 'AI', icon: MessageCircle },
  { id: 'sem', label: 'SEM', shortLabel: 'SEM', icon: Megaphone },
];

const CATEGORY_LABELS: Record<AuditCategory, string> = Object.fromEntries(
  Object.entries(CATEGORY_CONFIG).map(([id, value]) => [id, value.label]),
) as Record<AuditCategory, string>;

const CATEGORY_DESCRIPTIONS: Record<AuditCategory, string> = {
  discoverability: '搜索引擎能否访问页面、理解索引指令，并把页面加入索引。',
  metadata: '搜索结果中的标题、描述，以及页面主题是否表达清楚。',
  content: '正文结构、标题层级、语言和实体信息是否便于理解。',
  links: '链接是否有效，搜索引擎能否沿清晰路径发现站内页面。',
  media: '图片、视频和结构化数据是否提供完整、准确的语义。',
  performance: '本次访问的内容出现速度、服务器响应和页面视觉稳定性。',
};

const CATEGORY_ICONS: Record<AuditCategory, typeof CircleGauge> = {
  discoverability: Globe2,
  metadata: FileSearch,
  content: Braces,
  links: ArrowRight,
  media: Focus,
  performance: Zap,
};

const PERFORMANCE_METRICS = [
  { key: 'lcp', label: 'LCP', description: '最大内容出现速度', good: 2_500, poor: 4_000, unit: 'ms' as const, threshold: '良好 ≤ 2.5 s' },
  { key: 'cls', label: 'CLS', description: '页面布局稳定程度', good: 0.1, poor: 0.25, unit: 'score' as const, threshold: '良好 ≤ 0.1' },
  { key: 'fcp', label: 'FCP', description: '首个内容出现速度', good: 1_800, poor: 3_000, unit: 'ms' as const, threshold: '良好 ≤ 1.8 s' },
  { key: 'ttfb', label: 'TTFB', description: '服务器首字节速度', good: 800, poor: 1_800, unit: 'ms' as const, threshold: '良好 ≤ 800 ms' },
] as const;

const STATUS_LABELS: Record<AuditStatus, string> = {
  pass: '通过',
  warning: '警告',
  failure: '失败',
  informational: '信息',
  not_measurable: '不可测',
  not_applicable: '不适用',
};

const PRIORITY_ORDER: Record<AuditPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

async function rpc<T>(message: RuntimeMessage): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as RpcResponse<T>;
  if (!response?.ok) throw new Error(response?.error || '扩展请求失败。');
  return response.result as T;
}

function formatUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname}${url.search}`;
  } catch {
    return value;
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatMetric(value: number | null, unit: 'ms' | 'score'): string {
  if (value === null) return '不可测';
  if (unit === 'score') return value.toFixed(3);
  return `${Math.round(value)} ms`;
}

function formatBytes(value: number | null): string {
  if (value === null) return '不可测';
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function scoreTone(score: number | null): string {
  if (score === null) return 'neutral';
  if (score >= 90) return 'success';
  if (score >= 75) return 'good';
  if (score >= 50) return 'warning';
  return 'danger';
}

function priorityCounts(report: AuditReport): Record<AuditPriority, number> {
  const counts: Record<AuditPriority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of report.findings) {
    if (finding.status === 'failure' || finding.status === 'warning') counts[finding.priority] += 1;
  }
  return counts;
}

function scoreAvailabilityText(report: AuditReport): string {
  if (report.overallScore !== null) {
    return `总分由 ${report.measuredChecks} 项已取得证据的适用规则归一化计算，不可测项不会扣分。`;
  }
  if (report.measurableChecks === 0) return '当前页面没有适用的评分规则，请确认它是可公开访问的普通网页后重新扫描。';
  if (report.measuredChecks === 0) return '本次扫描没有取得可计分证据，请刷新被测页面后重新扫描。';
  return '评分数据不完整，请刷新被测页面后重新扫描。';
}

function reportToMarkdown(report: AuditReport): string {
  const lines = [
    '# SEO优化 页面审计报告',
    '',
    `- 页面：${report.url}`,
    `- 扫描时间：${new Date(report.createdAt).toLocaleString('zh-CN')}`,
    `- 总分：${report.overallScore ?? '证据不足'}（${report.scoreLabel}）`,
    `- 测量覆盖率：${report.coverage}%（${report.measuredChecks}/${report.measurableChecks}）`,
    '',
    '## 分类分数',
    '',
    ...report.categoryScores.map((item) => `- ${item.label}：${item.score ?? '不可测'}，问题 ${item.issueCount}`),
    '',
    '## 优先问题',
    '',
  ];
  const actionable = report.findings
    .filter((item) => item.status === 'failure' || item.status === 'warning')
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  if (actionable.length === 0) lines.push('本次页面级检查没有发现警告或失败项。');
  for (const finding of actionable) {
    lines.push(
      `### ${finding.priority} · ${finding.title}`,
      '',
      `- 证据：${finding.evidence}`,
      `- 影响：${finding.impact}`,
      `- 原因：${finding.explanation}`,
      `- 修改：${finding.recommendation}`,
      `- 不要这样修改：${finding.antiPattern || '不要同时叠加无关改动，也不要在证据不足时删除内容或代码。'}`,
      `- 检测证据与限制：${finding.limitations || '当前结论基于本次页面证据；实际收录、排名和业务结果仍需外部数据验证。'}`,
      `- 验证：${finding.verification}`,
      `- 观察周期：${finding.observationPeriod}`,
      `- 负责人 / 工作量：${finding.owner} / ${finding.effort}`,
      `- 回滚：${finding.rollback}`,
      '',
    );
  }
  if (report.snapshot.overseas) {
    const overseas = report.snapshot.overseas;
    lines.push(
      '## 海外站优化',
      '',
      `- 国际 SEO：${overseas.internationalSeo.status}`,
      `- 页面声明语言 / 正文语言候选 / 目标语言：${overseas.internationalSeo.htmlLang || '未声明'} / ${overseas.internationalSeo.detectedLanguage || '证据不足'} / ${overseas.internationalSeo.targetLanguage || '未设置'}`,
      `- hreflang：${overseas.internationalSeo.hreflangCount} 条；自引用：${overseas.internationalSeo.selfReference === null ? '不适用或尚未检测' : overseas.internationalSeo.selfReference ? '已观察到' : '未观察到'}`,
      `- Consent Mode：${overseas.consent.found ? '观察到命令' : '本次未观察到命令'}；顺序：${overseas.consent.orderValid === null ? '无法判断' : overseas.consent.orderValid ? 'default 在 update 之前' : '顺序需处理'}`,
      '',
      '### 标签与请求证据',
      '',
      ...overseas.tags.map((tag) => `- ${tag.platform}：${tag.ids.join('、') || '未识别 ID'}；初始化 ${tag.initialized ? '已观察到' : '未观察到'}；请求 ${tag.requestObserved ? '已观察到' : '未观察到'}`),
      '',
      '### 海外检测边界',
      '',
      ...overseas.limitations.map((item) => `- ${item}`),
      '',
    );
  }
  const technical = report.snapshot.technical;
  if (technical) {
    lines.push(
      '## 技术交付信号（不计入页面分数）',
      '',
      `- 搜索爬虫可访问性：${technical.crawler.explanation}`,
      `- HTTPS 与正式地址：${technical.transport.explanation}`,
      `- 压缩：${technical.compression.explanation}`,
      `- 缓存：${technical.cache.explanation}`,
      `- CSS/JavaScript：${technical.resources.blockingScripts} 个同步脚本，${technical.resources.blockingStylesheets} 个阻塞样式，${technical.resources.duplicateUrls.length} 个重复资源候选`,
      `- nofollow：页面级 ${technical.links.pageNofollow ? '有' : '无'}，内部链接 ${technical.links.internalNofollow} 个`,
      '',
      '### 技术检测限制',
      '',
      ...technical.limitations.map((item) => `- ${item}`),
      '',
    );
  }
  lines.push('## 需要外部数据', '', ...report.externalDataGaps.map((gap) => `- ${gap}`), '');
  return lines.join('\n');
}

function downloadJson(report: AuditReport): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `seo-opt-${new URL(report.url).hostname}-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function IconButton({
  label,
  children,
  onClick,
  disabled = false,
  pressed,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
    >
      {children}
    </button>
  );
}

function CodeAdvice({ finding, compact = false }: { finding: AuditFinding; compact?: boolean }) {
  const advice = getFindingCodeAdvice(finding);
  const [copied, setCopied] = useState(false);
  const copyCode = async () => {
    if (!advice.code) return;
    await navigator.clipboard.writeText(advice.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <div className={`code-advice${compact ? ' code-advice-compact' : ''}`}>
      <div className="code-advice-heading">
        <span><Code2 size={16} aria-hidden="true" />代码修改建议</span>
        <span className="code-advice-type">{advice.label}</span>
      </div>
      {advice.code ? (
        <>
          <div className="code-advice-toolbar">
            <span>{advice.language}</span>
            <button type="button" className="code-copy-button" onClick={() => void copyCode()} aria-label={`复制${advice.label}`}>
              {copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制'}
            </button>
          </div>
          <pre><code>{advice.code}</code></pre>
        </>
      ) : <p className="code-advice-empty">不适合直接用代码修复</p>}
      <p className="code-advice-note">{advice.note}</p>
    </div>
  );
}

function ScoreRing({ score, label, provisional = false }: { score: number | null; label: string; provisional?: boolean }) {
  const normalized = score ?? 0;
  const circumference = 2 * Math.PI * 49;
  const offset = circumference - (normalized / 100) * circumference;
  return (
    <div className={`score-ring score-${scoreTone(score)}`} aria-label={`页面 SEO 基础分 ${score ?? '证据不足'}，${label}`}>
      <span className="score-sticker" aria-hidden="true"><Sparkles size={15} /></span>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle className="score-track" cx="60" cy="60" r="49" />
        <circle
          className="score-value"
          cx="60"
          cy="60"
          r="49"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="score-ring-content">
        <span className="score-eyebrow">页面 SEO 基础分</span>
        <span className="score-number" data-testid="overall-score">
          {score ?? '—'}{score === null ? null : <span className="score-denominator">/100</span>}
        </span>
        <span className="score-label">{provisional ? '暂定 · ' : ''}{label}</span>
      </div>
    </div>
  );
}

function performanceTone(value: number | null, good: number, poor: number): 'neutral' | 'good' | 'warning' | 'danger' {
  if (value === null) return 'neutral';
  if (value <= good) return 'good';
  if (value <= poor) return 'warning';
  return 'danger';
}

function PerformanceMetrics({ performance }: { performance: AuditReport['snapshot']['performance'] }) {
  return (
    <div className="performance-grid" aria-label="本次访问性能指标">
      {PERFORMANCE_METRICS.map((metric) => {
        const value = performance[metric.key];
        const tone = performanceTone(value, metric.good, metric.poor);
        const state = tone === 'good' ? '良好' : tone === 'warning' ? '待改进' : tone === 'danger' ? '较差' : '样本不足';
        return (
          <div className={`performance-metric metric-${tone}`} key={metric.key}>
            <div className="performance-metric-heading">
              <span className="performance-name">{metric.label}</span>
              <span className="performance-state">{state}</span>
            </div>
            <p className="performance-value">{formatMetric(value, metric.unit)}</p>
            <span className="performance-description">{metric.description}</span>
            <span className="performance-threshold">{metric.threshold}</span>
          </div>
        );
      })}
    </div>
  );
}

function pointText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function ScoreBreakdown({ report, onOpenIssue }: { report: AuditReport; onOpenIssue: (finding: AuditFinding) => void }) {
  const [mode, setMode] = useState<'deducted' | 'passed'>('deducted');
  const details = useMemo(() => buildScoreDetails(report), [report]);
  const items = mode === 'deducted' ? details.deducted : details.passed;
  const strictestCap = details.caps[0];
  return (
    <section className="plain-section score-breakdown" aria-labelledby="score-breakdown-title">
      <div className="section-heading">
        <div>
          <p className="section-kicker">这次为什么得到这个分数</p>
          <h2 id="score-breakdown-title">得分与扣分明细</h2>
        </div>
        <span className="score-equation" aria-label={`获得 ${pointText(details.earnedPoints)} 分，可得 ${pointText(details.possiblePoints)} 分`}>
          {pointText(details.earnedPoints)} / {pointText(details.possiblePoints)}
        </span>
      </div>
      <div className="score-totals" aria-label="本次适用规则计分">
        <div><span>规则获得</span><p>{pointText(details.earnedPoints)}</p></div>
        <div><span>规则可得</span><p>{pointText(details.possiblePoints)}</p></div>
        <div><span>实际扣分</span><p>-{pointText(details.deductedPoints)}</p></div>
        <div><span>归一化</span><p>{details.normalizedScore ?? '—'}</p></div>
      </div>
      {strictestCap ? (
        <div className="score-cap-alert" role="note">
          <ShieldAlert size={18} aria-hidden="true" />
          <div>
            <span className="score-cap-title">评分封顶</span>
            <p>规则归一化得分为 {details.normalizedScore ?? '—'}，但存在索引风险，最终页面 SEO 基础分最高为 {strictestCap.cap}。</p>
            {details.caps.map(({ finding, cap }) => <button type="button" key={finding.id} onClick={() => onOpenIssue(finding)}>{finding.title} · 封顶 {cap}<ArrowRight size={15} /></button>)}
          </div>
        </div>
      ) : null}
      <div className="breakdown-switch" role="tablist" aria-label="得分和扣分明细">
        <button type="button" role="tab" aria-selected={mode === 'deducted'} className={mode === 'deducted' ? 'active' : ''} onClick={() => setMode('deducted')}>
          扣分项 <span>{details.deducted.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={mode === 'passed'} className={mode === 'passed' ? 'active' : ''} onClick={() => setMode('passed')}>
          得分项 <span>{details.passed.length}</span>
        </button>
      </div>
      <div className="score-detail-list" role="tabpanel">
        {items.length > 0 ? items.map((item) => {
          const content = (
            <>
              <span className={`score-detail-state status-${item.finding.status}`} aria-hidden="true">{item.finding.status === 'pass' ? <Check size={16} /> : <AlertCircle size={16} />}</span>
              <span className="score-detail-copy">
                <span className="score-detail-title">{item.finding.title}</span>
                <span className="score-detail-meta">{CATEGORY_LABELS[item.finding.category]} · {STATUS_LABELS[item.finding.status]}</span>
                <span className="score-detail-evidence">{item.finding.evidence}</span>
              </span>
              <span className="score-detail-points">
                <span>{pointText(item.earnedPoints)} / {pointText(item.possiblePoints)}</span>
                <span>{mode === 'deducted'
                  ? `扣 ${pointText(item.deductedPoints)}`
                  : item.deductedPoints === 0
                    ? '满分'
                    : `获得 ${pointText(item.earnedPoints)}`}</span>
              </span>
              {mode === 'deducted' ? <ArrowRight className="score-detail-arrow" size={17} aria-hidden="true" /> : null}
            </>
          );
          return mode === 'deducted'
            ? <button type="button" className="score-detail-row actionable" key={item.finding.id} onClick={() => onOpenIssue(item.finding)} aria-label={`查看问题：${item.finding.title}`}>{content}</button>
            : <div className="score-detail-row" key={item.finding.id}>{content}</div>;
        }) : <p className="empty-copy">本次没有{mode === 'deducted' ? '扣分项' : '得分项'}。</p>}
      </div>
      <p className="section-note concept-note">不可测和不适用规则不会进入分母。页面 SEO 基础分按本次适用规则归一化；若存在明确索引阻断，还会单独触发封顶。</p>
    </section>
  );
}

function QuickEvidenceStrip({ report }: { report: AuditReport }) {
  const snapshot = report.snapshot;
  const status = snapshot.siteProbe.page.status;
  const robots = [...snapshot.robotsMeta, snapshot.siteProbe.page.xRobotsTag || ''].join(',').toLowerCase();
  const indexSignal = robots.includes('noindex')
    ? '发现 noindex'
    : snapshot.siteProbe.robots.allowed === false
      ? 'robots 阻止'
      : status === 200
        ? '未发现阻断'
        : '需要确认';
  const title = snapshot.titleTags[0] ?? '';
  const h1Count = snapshot.headings.filter((heading) => heading.level === 1).length;
  return (
    <section className="quick-evidence" aria-label="页面关键数据">
      <div><span>HTTP</span><p>{status ?? '不可测'}</p></div>
      <div><span>索引信号</span><p>{indexSignal}</p></div>
      <div><span>Title</span><p>{title ? `${title.length} 字符` : '缺失'}</p></div>
      <div><span>H1</span><p>{h1Count} 个</p></div>
      <div><span>Canonical</span><p>{snapshot.canonicals.length === 1 ? '已声明' : snapshot.canonicals.length > 1 ? `${snapshot.canonicals.length} 个` : '未声明'}</p></div>
      <div><span>LCP</span><p>{formatMetric(snapshot.performance.lcp, 'ms')}</p></div>
    </section>
  );
}

function FilterMenu<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; count?: number }>;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const currentLabel = options.find((option) => option.value === value)?.label ?? value;

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const focusCurrentItem = () => {
    requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
    });
  };

  return (
    <div className="filter-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="filter-menu-trigger"
        aria-label={`${label}：${currentLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          setOpen(true);
          focusCurrentItem();
        }}
      >
        <span className="filter-menu-copy">
          <span className="filter-menu-label">{label}</span>
          <span className="filter-menu-value">{currentLabel}</span>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="filter-menu-popover"
          id={menuId}
          role="menu"
          aria-label={`${label}筛选`}
          onKeyDown={(event) => {
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
            const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
            let nextIndex = currentIndex;
            if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length;
            else if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + items.length) % items.length;
            else if (event.key === 'Home') nextIndex = 0;
            else if (event.key === 'End') nextIndex = items.length - 1;
            else return;
            event.preventDefault();
            items[nextIndex]?.focus();
          }}
        >
          {options.map((option) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <span>{option.label}</span>
              <span className="filter-option-end">
                {option.count !== undefined ? <span className="filter-option-count">{option.count}</span> : null}
                {option.value === value ? <Check size={16} aria-hidden="true" /> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TopRemediationQueue({ report, onOpenIssue, onRescan }: {
  report: AuditReport;
  onOpenIssue: (finding: AuditFinding) => void;
  onRescan: (context: AuditContext) => Promise<void>;
}) {
  const [tasks, setTasks] = useState<RemediationTask[]>([]);
  const [baselines, setBaselines] = useState<AuditBaseline[]>([]);
  const [retesting, setRetesting] = useState(false);
  const [loadError, setLoadError] = useState('');
  const actionableByRoot = useMemo(() => new Map(report.findings
    .filter((finding) => finding.status === 'failure' || finding.status === 'warning')
    .map((finding) => [finding.rootCauseId || finding.ruleId, finding])), [report.findings]);

  const refresh = useCallback(async () => {
    try {
      const project = await createProjectForOrigin(new URL(report.url).origin);
      const [storedTasks, storedBaselines] = await Promise.all([
        listRemediationTasks(project.id),
        listAuditBaselines(project.id),
      ]);
      const generated = tasksFromFindings(project.id, report.findings, storedTasks);
      await Promise.all(generated.map((task) => saveRemediationTask(task)));
      let nextBaselines = storedBaselines;
      if (!storedBaselines.some((baseline) => baseline.reportId === report.id)) {
        const baseline = baselineFromReport(project.id, report);
        await rpc({ type: 'SAVE_AUDIT_BASELINE', baseline });
        nextBaselines = [baseline, ...storedBaselines];
      }
      setTasks(generated);
      setBaselines(nextBaselines);
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : '无法加载优化建议。');
    }
  }, [report]);

  useEffect(() => { void refresh(); }, [refresh]);
  const currentBaseline = baselines.find((baseline) => baseline.reportId === report.id) || baselines[0];
  const previousBaseline = baselines.find((baseline) => baseline.id !== currentBaseline?.id);
  const baselineDiff = currentBaseline ? diffBaselines(previousBaseline, currentBaseline) : null;
  const topTasks = tasks.filter((task) => actionableByRoot.has(task.rootCauseId)).slice(0, 3);

  const retest = async () => {
    setRetesting(true);
    setLoadError('');
    try { await onRescan(report.context); }
    catch (reason) { setLoadError(reason instanceof Error ? reason.message : '重新验证失败。'); }
    finally { setRetesting(false); }
  };

  return (
    <section className="plain-section top-remediation" aria-labelledby="top-remediation-title">
      <div className="section-heading">
        <div><p className="section-kicker">先做这三项</p><h2 id="top-remediation-title">优先优化</h2></div>
        <button type="button" className="secondary-button" disabled={retesting} onClick={() => void retest()}><RefreshCw className={retesting ? 'spinner' : ''} size={17} />{retesting ? '正在复测' : '重新验证'}</button>
      </div>
      {baselineDiff && previousBaseline ? (
        <div className="baseline-diff" role="status">
          <span>与上次扫描相比</span>
          <p>基础分 {baselineDiff.score.before ?? '—'} → {baselineDiff.score.after ?? '—'}{baselineDiff.score.delta === null ? '' : `（${baselineDiff.score.delta >= 0 ? '+' : ''}${baselineDiff.score.delta}）`} · 已通过 {baselineDiff.fixedRules.length} 项 · 新增 {baselineDiff.newRules.length} 项</p>
        </div>
      ) : <p className="section-note">先按这三项建议修改页面，再点击“重新验证”查看扫描前后的差异。</p>}
      {loadError ? <div className="inline-alert" role="alert"><AlertCircle size={16} />{loadError}</div> : null}
      {topTasks.length ? <div className="top-remediation-list">{topTasks.map((task, index) => {
        const finding = actionableByRoot.get(task.rootCauseId);
        return (
          <article className={`top-remediation-item priority-${task.priority.toLowerCase()}`} key={task.id}>
            <span className="remediation-order">{index + 1}</span>
            <div className="remediation-copy"><span className="remediation-priority">{task.priority} · {task.owner} · {task.effort}工作量</span><h3>{task.title}</h3><p>{task.action}</p></div>
            <div className="remediation-actions">
              {finding ? <button type="button" className="text-button" onClick={() => onOpenIssue(finding)}>查看证据<ArrowRight size={16} /></button> : null}
            </div>
          </article>
        );
      })}</div> : <div className="top-remediation-empty"><Check size={18} /><span>当前没有失败或警告项。继续结合搜索表现和站点审计验证站外结果。</span></div>}
    </section>
  );
}

function Overview({
  report,
  onContextUpdated,
  onRescan,
  onOpenIssue,
}: {
  report: AuditReport;
  onContextUpdated: (report: AuditReport) => void;
  onRescan: (context: AuditContext) => Promise<void>;
  onOpenIssue: (finding: AuditFinding) => void;
}) {
  const [section, setSection] = useState<OverviewSection>('summary');
  const counts = priorityCounts(report);
  const scoreExplanation = scoreAvailabilityText(report);
  return (
    <div className="view-stack">
      <nav className="overview-sections" role="tablist" aria-label="概览内容">
        <button type="button" role="tab" aria-selected={section === 'summary'} className={section === 'summary' ? 'active' : ''} onClick={() => setSection('summary')}><CircleGauge size={17} />摘要</button>
        <button type="button" role="tab" aria-selected={section === 'page-info'} className={section === 'page-info' ? 'active' : ''} onClick={() => setSection('page-info')}><FileSearch size={17} />页面信息</button>
        <button type="button" role="tab" aria-selected={section === 'crawl-evidence'} className={section === 'crawl-evidence' ? 'active' : ''} onClick={() => setSection('crawl-evidence')}><Globe2 size={17} />页面数据</button>
        <button type="button" role="tab" aria-selected={section === 'site-audit'} className={section === 'site-audit' ? 'active' : ''} onClick={() => setSection('site-audit')}><ScanSearch size={17} />站点审计</button>
      </nav>

      {section === 'summary' ? (
        <div className="view-stack overview-panel" role="tabpanel" aria-label="摘要">
          <section className="score-overview" aria-labelledby="score-title">
            <div>
              <p className="section-kicker">页面级 SEO 审计</p>
              <h2 id="score-title">{formatUrl(report.url)}</h2>
              <p className="scan-meta">扫描于 {formatTime(report.createdAt)} · 本次结果不代表实际收录或排名</p>
              <p className={`score-help ${report.overallScore === null ? 'score-help-warning' : ''}`}>
                <Info size={15} aria-hidden="true" />
                <span>{scoreExplanation}</span>
              </p>
              <p className="concept-explainer"><span>怎么看：</span>页面 SEO 基础分只表示当前页面可测的 SEO 基础是否完整，不代表已经收录、有排名或一定能获得流量。</p>
            </div>
            <ScoreRing score={report.overallScore} label={report.scoreLabel} provisional={report.coverage < 60} />
          </section>

          <QuickEvidenceStrip report={report} />
          <TopRemediationQueue report={report} onOpenIssue={onOpenIssue} onRescan={onRescan} />
          <ScoreBreakdown report={report} onOpenIssue={onOpenIssue} />

          <section className="metric-strip" aria-label="测量和问题概况">
            <div className="metric-cell">
              <span className="metric-label">测量覆盖</span>
              <span className="metric-value">{report.coverage}%</span>
              <span className="metric-note">{report.measuredChecks}/{report.measurableChecks} 项</span>
            </div>
            {(['P0', 'P1', 'P2', 'P3'] as AuditPriority[]).map((priority) => (
              <div className={`metric-cell priority-${priority.toLocaleLowerCase()}`} key={priority}>
                <span className="metric-label">{priority}</span>
                <span className="metric-value">{counts[priority]}</span>
                <span className="metric-note">{priority === 'P0' ? '阻断' : priority === 'P1' ? '高影响' : priority === 'P2' ? '增长' : '观察'}</span>
              </div>
            ))}
          </section>
          <p className="concept-explainer metric-explainer"><span>怎么看：</span>覆盖率是本次成功取得证据的规则比例；P0 必须先处理，P1 高影响，P2 属于增长优化，P3 先观察。它们表示处理顺序，不是问题数量越多就一定越差。</p>

          <section className="plain-section" aria-labelledby="category-title">
            <div className="section-heading">
              <div>
                <p className="section-kicker">六类信号</p>
                <h2 id="category-title">分类得分</h2>
              </div>
            </div>
            <div className="category-list">
              {report.categoryScores.map((category) => {
                const CategoryIcon = CATEGORY_ICONS[category.category];
                return (
                <div className={`category-row category-${category.category}`} key={category.category}>
                  <div className="category-label-row">
                    <span className="category-icon" aria-hidden="true"><CategoryIcon size={18} /></span>
                    <span className="category-title-block">
                      <span className="category-name">{category.label}</span>
                      <span className="category-description">{CATEGORY_DESCRIPTIONS[category.category]}</span>
                    </span>
                    <span className="category-value">
                      {category.score ?? '—'} <span>· {category.issueCount} 个问题</span>
                    </span>
                  </div>
                  <div className="progress-track" aria-hidden="true">
                    <span className={`progress-value score-${scoreTone(category.score)}`} style={{ width: `${category.score ?? 0}%` }} />
                  </div>
                </div>
              );})}
            </div>
            <p className="section-note concept-note">分类分数用于定位薄弱环节，不建议为了满分机械修改。先处理会阻断抓取、索引或用户任务的问题，再结合真实搜索表现决定增长项。</p>
          </section>

          <section className="plain-section performance-overview" aria-labelledby="overview-performance-title">
            <div className="section-heading">
              <div>
                <p className="section-kicker">性能信号</p>
                <h2 id="overview-performance-title">本次访问性能</h2>
              </div>
              <MonitorCog size={18} aria-hidden="true" />
            </div>
            <PerformanceMetrics performance={report.snapshot.performance} />
            <p className="section-note concept-note">怎么看：LCP 是主要内容多久出现，CLS 是页面会不会突然跳动，FCP 是第一块内容多久可见，TTFB 是服务器多久开始返回。这里只是当前设备与网络的一次测试，不等同于所有真实用户的表现。</p>
          </section>

          <SeoGrowthSections report={report} onContextUpdated={onContextUpdated} onRescan={onRescan} mode="summary" />
        </div>
      ) : null}

      {section === 'page-info' ? (
        <div className="view-stack overview-panel" role="tabpanel" aria-label="页面信息">
          <section className="evidence-intro" aria-labelledby="overview-page-data-title">
            <span className="playful-icon" aria-hidden="true"><FileSearch size={19} /></span>
            <div><p className="section-kicker">浏览器现在看到的内容</p><h2 id="overview-page-data-title">页面信息</h2><p>展示 Title、描述、标题结构、链接和媒体。它能说明页面写了什么，但不能证明搜索引擎已经收录。</p></div>
          </section>
          <PageDataView report={report} />
        </div>
      ) : null}

      {section === 'crawl-evidence' ? (
        <div className="view-stack overview-panel" role="tabpanel" aria-label="页面数据">
          <section className="evidence-intro" aria-labelledby="overview-site-signals-title">
            <span className="playful-icon" aria-hidden="true"><Globe2 size={19} /></span>
            <div><p className="section-kicker">服务器与搜索引擎入口</p><h2 id="overview-site-signals-title">页面数据</h2><p>检查真实 GET、抓取规则（robots.txt）、页面清单（Sitemap）和原始 HTML，用来判断搜索引擎能否访问并读懂页面。</p></div>
          </section>
          <SiteSignalsView report={report} onReportUpdated={onContextUpdated} />
          <section className="plain-section external-data" aria-labelledby="external-data-title">
            <div className="section-heading">
              <div><p className="section-kicker">当前页面无法直接证明</p><h2 id="external-data-title">还需要哪些数据</h2><p className="heading-help">实际收录、排名、点击和转化发生在搜索平台与业务系统中，不会因为页面代码看起来正确就自动成立。</p></div>
              <Info size={18} aria-hidden="true" />
            </div>
            <ul className="clean-list">{report.externalDataGaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>
          </section>
        </div>
      ) : null}

      {section === 'site-audit' ? (
        <div className="view-stack overview-panel" role="tabpanel" aria-label="站点审计">
          <SeoGrowthSections report={report} onContextUpdated={onContextUpdated} onRescan={onRescan} mode="site-audit" />
        </div>
      ) : null}
    </div>
  );
}

function RecommendationsView({
  report,
  onLocate,
  onOpenIssue,
}: {
  report: AuditReport;
  onLocate: (finding: AuditFinding) => void;
  onOpenIssue: (finding: AuditFinding) => void;
}) {
  const sections = useMemo(() => buildRecommendationSections(report.findings), [report.findings]);
  const rootGroups = useMemo(() => groupRecommendationsByRootCause(report.findings), [report.findings]);
  const groupForFinding = (finding: AuditFinding) => rootGroups.find((group) => group.id === finding.rootCauseId);
  const actionableCount = sections.reduce((total, section) => total + section.findings.length, 0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(sections.flatMap((section) => section.findings[0]?.id ? [section.findings[0].id] : [])));
  return (
    <div className="view-stack recommendations-view">
      <section className="recommendation-intro" aria-labelledby="recommendation-title">
        <div>
          <p className="section-kicker">执行队列</p>
          <h2 id="recommendation-title">从哪里开始优化</h2>
          <p>按风险、影响和工作量自动整理。预期效果不是排名承诺，修改后先重新扫描，再结合搜索与转化数据验证。</p>
        </div>
        <span className="recommendation-count" aria-label={`${actionableCount} 项待优化`}>
          <span>{actionableCount}</span> 项
        </span>
      </section>
      {actionableCount === 0 ? (
        <section className="recommendation-empty" role="status">
          <Check size={26} aria-hidden="true" />
          <div><h2>当前没有页面级待办</h2><p>继续结合搜索平台、真实用户性能和转化数据验证站外结果。</p></div>
        </section>
      ) : sections.map((section) => (
        section.findings.length > 0 ? (
          <section className={`recommendation-section recommendation-${section.id}`} key={section.id} aria-labelledby={`recommendation-${section.id}`}>
            <div className="recommendation-section-heading">
              <span className="recommendation-section-icon" aria-hidden="true">
                {section.id === 'quick_wins' ? <Zap size={17} /> : <Lightbulb size={17} />}
              </span>
              <div>
                <h2 id={`recommendation-${section.id}`}>{section.title}</h2>
                <p>{section.description}</p>
              </div>
              <span className="recommendation-section-count">{section.findings.length}</span>
            </div>
            <div className="recommendation-list">
              {section.findings.map((finding) => {
                const isExpanded = expanded.has(finding.id);
                return (
                <article className="recommendation-item" key={finding.id}>
                  <button type="button" className="recommendation-summary" aria-expanded={isExpanded} onClick={() => setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(finding.id)) next.delete(finding.id); else next.add(finding.id);
                    return next;
                  })}>
                    <span className="recommendation-summary-copy">
                      <span className="recommendation-meta"><span className={`priority-badge priority-${finding.priority.toLocaleLowerCase()}`}>{finding.priority}</span><span>{CATEGORY_LABELS[finding.category]}</span><span>{finding.owner} · {finding.effort}工作量</span></span>
                      <span className="recommendation-title-text">{finding.title}</span>
                      <span className="recommendation-preview">{finding.recommendation}</span>
                    </span>
                    {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                  </button>
                  {isExpanded ? <div className="recommendation-expanded">
                    {groupForFinding(finding) && groupForFinding(finding)!.findings.length > 1 ? <p className="root-cause-summary">同一根因合并 {groupForFinding(finding)!.findings.length} 个问题，影响 {Math.max(1, groupForFinding(finding)!.affectedUrls.length)} 个 URL。</p> : null}
                    <dl className="recommendation-detail">
                      <div><dt>证据</dt><dd>{finding.evidence}</dd></div>
                      <div><dt>为什么要优化</dt><dd>{finding.explanation}</dd></div>
                      <div><dt>当前影响</dt><dd>{finding.impact}</dd></div>
                      <div className="recommendation-outcome"><dt>优化后预期</dt><dd>{getExpectedOutcome(finding)}</dd></div>
                      <div><dt>怎么做</dt><dd>{finding.recommendation}</dd></div>
                      <div><dt>如何验证</dt><dd>{finding.verification}</dd></div>
                      <div><dt>不要这样修改</dt><dd>{finding.antiPattern || '不要同时叠加多项无关改动，也不要在没有验证证据时删除内容或代码。'}</dd></div>
                      <div><dt>检测证据与限制</dt><dd>{finding.limitations || '当前结论基于本次页面证据；实际搜索结果还需要搜索平台和业务数据验证。'}</dd></div>
                      <div><dt>观察与回滚</dt><dd>{finding.observationPeriod}；{finding.rollback}</dd></div>
                    </dl>
                    <CodeAdvice finding={finding} compact />
                    <div className="recommendation-actions">
                      {finding.locator ? <button type="button" className="secondary-button" onClick={() => onLocate(finding)}><MapPin size={16} />网页定位</button> : null}
                      <button type="button" className="text-button" onClick={() => onOpenIssue(finding)}>查看完整问题<ArrowRight size={16} /></button>
                    </div>
                  </div> : null}
                </article>
              );})}
            </div>
          </section>
        ) : null
      ))}

    </div>
  );
}

function IssueCard({
  finding,
  expanded,
  onToggle,
  onLocate,
}: {
  finding: AuditFinding;
  expanded: boolean;
  onToggle: () => void;
  onLocate: () => void;
}) {
  const actionable = finding.status === 'failure' || finding.status === 'warning';
  return (
    <article className={`issue-card status-${finding.status}`} data-testid={`finding-${finding.ruleId}`} data-finding-id={finding.id}>
      <button type="button" className="issue-summary" onClick={onToggle} aria-expanded={expanded}>
        <span className={`status-marker status-${finding.status}`} aria-hidden="true" />
        <span className="issue-summary-main">
          <span className="issue-title-row">
            <span className={`priority-badge priority-${finding.priority.toLocaleLowerCase()}`}>{finding.priority}</span>
            <span className="issue-title">{finding.title}</span>
          </span>
          <span className="issue-evidence">{finding.evidence}</span>
        </span>
        {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
      </button>
      {expanded ? (
        <div className="issue-details">
          <dl className="explanation-grid">
            <div>
              <dt>影响</dt>
              <dd>{finding.impact}</dd>
            </div>
            <div>
              <dt>为什么</dt>
              <dd>{finding.explanation}</dd>
            </div>
            <div>
              <dt>修改步骤</dt>
              <dd>{finding.recommendation}</dd>
            </div>
            <div>
              <dt>验证方法</dt>
              <dd>{finding.verification}</dd>
            </div>
            <div>
              <dt>观察周期</dt>
              <dd>{finding.observationPeriod}</dd>
            </div>
            <div>
              <dt>风险与回滚</dt>
              <dd>{finding.rollback}</dd>
            </div>
            <div>
              <dt>不要这样修改</dt>
              <dd>{finding.antiPattern || '不要同时叠加多项无关改动，也不要在没有验证证据时删除内容或代码。'}</dd>
            </div>
            <div>
              <dt>检测证据与限制</dt>
              <dd>{finding.limitations || '当前结论基于本次页面证据；实际搜索结果还需要搜索平台和业务数据验证。'}</dd>
            </div>
          </dl>
          <CodeAdvice finding={finding} />
          <div className="issue-footer">
            <span>{CATEGORY_LABELS[finding.category]} · {finding.owner} · {finding.effort}工作量</span>
            {actionable && finding.locator ? (
              <button type="button" className="secondary-button compact-button" onClick={onLocate}>
                <MapPin size={16} />
                网页定位
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function scrollIssueCardIntoView(element: HTMLElement | null): void {
  if (!element) return;
  const scrollContainer = element.closest<HTMLElement>('.virtual-scroll')
    ?? document.querySelector<HTMLElement>('.app-main');
  if (!scrollContainer) {
    element.scrollIntoView({ block: 'start' });
    return;
  }

  const containerRect = scrollContainer.getBoundingClientRect();
  const filterToolbar = document.querySelector<HTMLElement>('.filter-toolbar');
  const toolbarRect = filterToolbar?.getBoundingClientRect();
  const visibleTop = Math.max(containerRect.top + 8, toolbarRect?.bottom ?? containerRect.top + 8);
  const elementRect = element.getBoundingClientRect();
  const delta = elementRect.top < visibleTop
    ? elementRect.top - visibleTop
    : elementRect.bottom > containerRect.bottom - 8
      ? elementRect.top - visibleTop
      : 0;

  if (delta !== 0) {
    const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
    scrollContainer.scrollTop = Math.max(0, Math.min(maxScrollTop, scrollContainer.scrollTop + delta));
  }
}

function IssueList({
  findings,
  onLocate,
  initialExpandedId,
}: {
  findings: AuditFinding[];
  onLocate: (finding: AuditFinding) => void;
  initialExpandedId: string | null;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(initialExpandedId);
  const parentRef = useRef<HTMLDivElement>(null);
  const useVirtual = findings.length > 100;
  const virtualizer = useVirtualizer({
    count: useVirtual ? findings.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 124,
    overscan: 6,
  });

  useEffect(() => {
    if (expandedId && !findings.some((finding) => finding.id === expandedId)) setExpandedId(null);
  }, [expandedId, findings]);

  useLayoutEffect(() => {
    if (!initialExpandedId || !findings.some((finding) => finding.id === initialExpandedId)) return;
    setExpandedId(initialExpandedId);
    const selector = `[data-finding-id="${CSS.escape(initialExpandedId)}"]`;
    scrollIssueCardIntoView(document.querySelector<HTMLElement>(selector));
    const frame = requestAnimationFrame(() => scrollIssueCardIntoView(document.querySelector<HTMLElement>(selector)));
    return () => cancelAnimationFrame(frame);
  }, [findings, initialExpandedId]);

  const toggleIssue = (finding: AuditFinding) => {
    const nextExpandedId = expandedId === finding.id ? null : finding.id;
    setExpandedId(nextExpandedId);
    if (!nextExpandedId) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      scrollIssueCardIntoView(
        document.querySelector<HTMLElement>(`[data-finding-id="${CSS.escape(finding.id)}"]`),
      );
    }));
  };

  if (findings.length === 0) {
    return (
      <div className="empty-state">
        <Check size={28} />
        <h2>当前筛选没有结果</h2>
        <p>调整优先级、分类或状态筛选，查看其他检查项。</p>
      </div>
    );
  }

  if (!useVirtual) {
    return (
      <div className="issue-list">
        {findings.map((finding) => (
          <IssueCard
            key={finding.id}
            finding={finding}
            expanded={expandedId === finding.id}
            onToggle={() => toggleIssue(finding)}
            onLocate={() => onLocate(finding)}
          />
        ))}
      </div>
    );
  }

  return (
    <div ref={parentRef} className="virtual-scroll" data-testid="virtual-issue-list">
      <div className="virtual-content" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((item) => {
          const finding = findings[item.index]!;
          return (
            <div
              key={finding.id}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="virtual-row"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <IssueCard
                finding={finding}
                expanded={expandedId === finding.id}
                onToggle={() => toggleIssue(finding)}
                onLocate={() => onLocate(finding)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IssuesView({
  report,
  onLocate,
  initialExpandedId,
}: {
  report: AuditReport;
  onLocate: (finding: AuditFinding) => void;
  initialExpandedId: string | null;
}) {
  const stateKey = `seo-opt:issue-view:${new URL(report.url).origin}`;
  const restored = useMemo(() => {
    try { return JSON.parse(sessionStorage.getItem(stateKey) || '{}') as { priority?: AuditPriority | 'all'; category?: AuditCategory | 'all'; status?: IssueStatusFilter }; }
    catch { return {}; }
  }, [stateKey]);
  const [priority, setPriority] = useState<AuditPriority | 'all'>(restored.priority || 'all');
  const [category, setCategory] = useState<AuditCategory | 'all'>(restored.category || 'all');
  const [status, setStatus] = useState<IssueStatusFilter>(restored.status || 'actionable');
  useEffect(() => {
    sessionStorage.setItem(stateKey, JSON.stringify({ priority, category, status }));
  }, [category, priority, stateKey, status]);
  useLayoutEffect(() => {
    const main = document.querySelector<HTMLElement>('.app-main');
    if (!main) return;
    const scrollKey = `${stateKey}:scroll`;
    main.scrollTop = Number(sessionStorage.getItem(scrollKey) || 0);
    const rememberScroll = () => sessionStorage.setItem(scrollKey, String(main.scrollTop));
    main.addEventListener('scroll', rememberScroll, { passive: true });
    return () => { rememberScroll(); main.removeEventListener('scroll', rememberScroll); };
  }, [stateKey]);
  const priorityOptions: Array<{ value: AuditPriority | 'all'; label: string }> = [
    { value: 'all', label: '全部' },
    { value: 'P0', label: 'P0' },
    { value: 'P1', label: 'P1' },
    { value: 'P2', label: 'P2' },
    { value: 'P3', label: 'P3' },
  ];
  const categoryCounts = useMemo(
    () => countIssueCategories(report.findings, priority, status),
    [priority, report.findings, status],
  );
  const categoryOptions: Array<{ value: AuditCategory | 'all'; label: string; count: number }> = [
    { value: 'all', label: '全部分类', count: categoryCounts.all },
    ...Object.entries(CATEGORY_LABELS).map(([value, label]) => ({
      value: value as AuditCategory,
      label,
      count: categoryCounts[value as AuditCategory],
    })),
  ];
  const statusOptions: Array<{ value: IssueStatusFilter; label: string }> = [
    { value: 'actionable', label: '未通过（失败/警告）' },
    { value: 'all', label: '全部状态' },
    ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value: value as AuditStatus, label })),
  ];
  const filtersChanged = priority !== 'all' || category !== 'all' || status !== 'actionable';

  const findings = useMemo(() => {
    return filterIssueFindings(report.findings, { priority, category, status })
      .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  }, [category, priority, report.findings, status]);

  return (
    <div className="issues-view">
      <div className="filter-toolbar" aria-label="问题筛选">
        <div className="filter-toolbar-heading">
          <span className="filter-toolbar-title"><Filter size={16} aria-hidden="true" />筛选问题</span>
          <span className="result-count" aria-live="polite">{findings.length} 项结果</span>
        </div>
        <div className="priority-filter" role="group" aria-label="优先级筛选">
          {priorityOptions.map((option) => (
            <button
              type="button"
              key={option.value}
              className={priority === option.value ? 'active' : ''}
              aria-pressed={priority === option.value}
              title={option.value === 'P0' ? 'P0 阻断' : option.value === 'P1' ? 'P1 高影响' : option.value === 'P2' ? 'P2 增长' : option.value === 'P3' ? 'P3 观察' : '全部优先级'}
              onClick={() => setPriority(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="filter-menu-row">
          <FilterMenu label="分类" value={category} options={categoryOptions} onChange={setCategory} />
          <FilterMenu label="状态" value={status} options={statusOptions} onChange={setStatus} />
          <IconButton
            label="重置筛选"
            disabled={!filtersChanged}
            onClick={() => {
              setPriority('all');
              setCategory('all');
              setStatus('actionable');
            }}
          >
            <X size={17} />
          </IconButton>
        </div>
      </div>
      <IssueList findings={findings} onLocate={onLocate} initialExpandedId={initialExpandedId} />
    </div>
  );
}

function DataRow({ label, value, code = false }: { label: string; value: ReactNode; code?: boolean }) {
  return (
    <div className="data-row">
      <dt>{label}</dt>
      <dd className={code ? 'code-value' : ''}>{value}</dd>
    </div>
  );
}

function PageDataView({ report }: { report: AuditReport }) {
  const snapshot = report.snapshot;
  const h1s = snapshot.headings.filter((heading) => heading.level === 1);
  const internalLinks = snapshot.links.filter((link) => link.isInternal).length;
  const missingAlt = snapshot.images.filter((image) => image.alt === null).length;
  return (
    <div className="view-stack">
      <section className="plain-section">
        <div className="section-heading">
          <div><p className="section-kicker">搜索摘要</p><h2>元信息</h2></div>
          <Braces size={18} />
        </div>
        <dl className="data-table">
          <DataRow label="Title" value={snapshot.titleTags[0] || '缺失'} code />
          <DataRow label="Title 数量" value={snapshot.titleTags.length} />
          <DataRow label="Description" value={snapshot.descriptions[0] || '缺失'} code />
          <DataRow label="Canonical" value={snapshot.canonicals[0] || '缺失'} code />
          <DataRow label="Robots meta" value={snapshot.robotsMeta.join(' · ') || '未显式声明'} code />
          <DataRow label="HTML lang" value={snapshot.htmlLang || '缺失'} code />
        </dl>
      </section>

      <section className="plain-section">
        <div className="section-heading"><div><p className="section-kicker">结构</p><h2>内容与标题</h2></div></div>
        <dl className="data-table">
          <DataRow label="可见文本" value={`${snapshot.visibleTextLength.toLocaleString('zh-CN')} 字符`} />
          <DataRow label="H1" value={h1s.length > 0 ? h1s.map((item) => item.text || '空 H1').join(' · ') : '缺失'} />
          <DataRow label="标题总数" value={snapshot.headings.length} />
          <DataRow label="Main 区域" value={snapshot.mainCount} />
          <DataRow label="作者 / 日期" value={`${snapshot.articleAuthorPresent ? '有作者信号' : '无作者信号'} · ${snapshot.articleDatePresent ? '有日期信号' : '无日期信号'}`} />
        </dl>
        {snapshot.headings.length > 0 ? (
          <ol className="heading-tree">
            {snapshot.headings.slice(0, 60).map((heading, index) => (
              <li key={`${heading.level}-${heading.text}-${index}`} style={{ paddingInlineStart: `${Math.max(0, heading.level - 1) * 10}px` }}>
                <span>H{heading.level}</span>{heading.text || '空标题'}
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <section className="plain-section">
        <div className="section-heading"><div><p className="section-kicker">页面资产</p><h2>链接、媒体与结构化数据</h2></div></div>
        <dl className="data-table">
          <DataRow label="链接" value={`${snapshot.links.length} 个 · ${internalLinks} 个内部链接`} />
          <DataRow label="图片" value={`${snapshot.images.length} 张 · ${missingAlt} 张缺失 Alt`} />
          <DataRow label="视频" value={snapshot.videos.length} />
          <DataRow label="JSON-LD" value={snapshot.jsonLd.length > 0 ? snapshot.jsonLd.map((item) => item.valid ? item.types.join('/') || '有效 JSON' : `错误：${item.error}`).join(' · ') : '未检测到'} />
        </dl>
      </section>

    </div>
  );
}

function SignalState({ value }: { value: boolean | null }) {
  if (value === null) return <span className="signal-state neutral"><Info size={15} />不可测</span>;
  return value
    ? <span className="signal-state pass"><Check size={15} />通过</span>
    : <span className="signal-state fail"><X size={15} />失败</span>;
}

const TECHNICAL_STATUS: Record<TechnicalSignalStatus, { label: string; className: string; icon: typeof Check }> = {
  good: { label: '正常', className: 'good', icon: Check },
  attention: { label: '需要处理', className: 'attention', icon: AlertCircle },
  confirm: { label: '需要确认', className: 'confirm', icon: Info },
  unavailable: { label: '无法检测', className: 'unavailable', icon: ShieldAlert },
};

function TechnicalStatusBadge({ status }: { status: TechnicalSignalStatus }) {
  const config = TECHNICAL_STATUS[status];
  const Icon = config.icon;
  return <span className={`technical-status ${config.className}`}><Icon size={15} aria-hidden="true" />{config.label}</span>;
}

function headerValue(value: string | number | null | undefined): string | number {
  return value === null || value === undefined || value === '' ? '未声明' : value;
}

function SiteSignalsView({ report, onReportUpdated }: { report: AuditReport; onReportUpdated: (report: AuditReport) => void }) {
  const { siteProbe, rawComparison, technical } = report.snapshot;
  const [checkingEntries, setCheckingEntries] = useState(false);
  const [entryError, setEntryError] = useState('');
  const checkEntries = async () => {
    const { buildSiteEntryUrls } = await import('../../src/lib/audit/technical');
    const entryUrls = buildSiteEntryUrls(report.url);
    if (!entryUrls.length) {
      setEntryError('本机、IP 或无法识别的域名不适用 www/非 www 入口检查。');
      return;
    }
    const origins = [...new Set(entryUrls.map((url) => `${new URL(url).origin}/*`))];
    setCheckingEntries(true);
    setEntryError('');
    try {
      const alreadyGranted = await chrome.permissions.contains({ origins });
      const granted = alreadyGranted || await chrome.permissions.request({ origins });
      if (!granted) {
        setEntryError('未授予网站入口权限。基础页面检查仍可使用，插件不会在下次扫描时自动重复询问。');
        return;
      }
      const updated = await rpc<AuditReport>({ type: 'CHECK_SITE_ENTRIES', report });
      onReportUpdated(updated);
    } catch (error) {
      setEntryError(error instanceof Error ? error.message : '网站入口检查失败。');
    } finally {
      setCheckingEntries(false);
    }
  };

  if (!technical) {
    return (
      <section className="plain-section technical-empty" role="status">
        <ShieldAlert size={20} aria-hidden="true" />
        <div><h2>这份报告还没有技术交付数据</h2><p>重新扫描页面后，可以检查 HTTPS、响应头、缓存、资源加载和搜索爬虫可访问性。</p></div>
      </section>
    );
  }

  const { transport, compression, cache, resources, links, crawler, schemaSuggestions } = technical;
  const robotsStatus: TechnicalSignalStatus = siteProbe.robots.error
    ? 'unavailable'
    : siteProbe.robots.allowed === false
      ? 'attention'
      : (siteProbe.robots.syntaxIssues?.length || siteProbe.robots.blockedResources?.length)
        ? 'confirm'
        : 'good';
  const enrichedResources = resources.resources.filter((item) => item.headers);
  const resourceCompressionRisks = enrichedResources.filter((item) => item.compression?.status === 'attention').length;
  const resourceCacheRisks = enrichedResources.filter((item) => item.cache?.status === 'attention' || item.cache?.status === 'confirm').length;
  return (
    <div className="view-stack">
      <section className="plain-section technical-section technical-crawler">
        <div className="section-heading"><div><p className="section-kicker">1 · 先确认能不能读取</p><h2>搜索引擎能否访问</h2><p className="heading-help">使用不带登录信息的真实 GET，检查公开访问时服务器返回什么。它不是伪装成 Googlebot。</p></div><TechnicalStatusBadge status={crawler.status} /></div>
        <p className="technical-conclusion">{crawler.explanation}</p>
        <dl className="data-table">
          <DataRow label="匿名 GET 状态" value={crawler.statusCode ?? '请求失败'} />
          <DataRow label="robots 是否允许" value={crawler.robotsAllowed === null ? '不可测' : crawler.robotsAllowed ? '允许当前路径' : '阻止当前路径'} />
          <DataRow label="原始 HTML" value={`${crawler.rawHasTitle ? '有 Title' : '缺 Title'} · ${crawler.rawHasH1 ? '有 H1' : '缺 H1'} · ${crawler.rawHasMainContent ? '有主要正文' : '正文不足/不可测'} · ${crawler.rawHasInternalLinks ? '有内链' : '缺内链'}`} />
          <DataRow label="依赖渲染的字段" value={crawler.renderDependentFields.join('、') || '未发现'} />
          {siteProbe.page.error ? <DataRow label="错误" value={siteProbe.page.error} /> : null}
        </dl>
      </section>

      <section className="plain-section technical-section">
        <div className="section-heading"><div><p className="section-kicker">2 · 统一访问入口</p><h2>HTTPS 与网站正式地址</h2><p className="heading-help">重点不是必须使用 www，而是所有可访问入口最终指向同一个 HTTPS 正式地址。</p></div><TechnicalStatusBadge status={transport.status} /></div>
        <p className="technical-conclusion">{transport.explanation}</p>
        <dl className="data-table">
          <DataRow label="当前协议" value={transport.currentProtocol || '不可测'} code />
          <DataRow label="正式主机" value={transport.preferredHost || '无法推断'} code />
          <DataRow label="HSTS" value={transport.hsts === null ? '不适用/不可测' : transport.hsts ? '已声明' : '未发现'} />
          <DataRow label="HTTP 混合资源" value={transport.mixedContentUrls.length ? `${transport.mixedContentUrls.length} 个候选` : '未发现'} />
          <DataRow label="证书详情" value="浏览器扩展不可读取到期时间、证书链和 TLS 等级" />
        </dl>
        <button type="button" className="secondary-button technical-check-button" onClick={() => void checkEntries()} disabled={checkingEntries}>
          <Globe2 size={17} aria-hidden="true" />{checkingEntries ? '正在检查四个入口' : transport.variants.length ? '重新检查网站入口' : '完整检查网站入口'}
        </button>
        {entryError ? <div className="inline-alert" role="alert"><AlertCircle size={16} />{entryError}</div> : null}
        {transport.variants.length ? <details className="technical-details"><summary>查看 HTTP / HTTPS / www / 非 www 结果</summary><div className="technical-detail-body"><dl className="data-table">{transport.variants.map((item) => <DataRow key={item.requestedUrl} label={item.requestedUrl} value={`${item.status ?? '失败'} → ${item.finalUrl || '无最终地址'} · ${item.redirectCount} 次跳转${item.chainComplete ? '' : ' · 链路不完整'}${item.error ? ` · ${item.error}` : ''}`} code />)}</dl></div></details> : null}
      </section>

      <section className="plain-section technical-section">
        <div className="section-heading"><div><p className="section-kicker">3 · 减少重复下载</p><h2>压缩与缓存</h2><p className="heading-help">压缩减少文本传输量，缓存让不常变化的资源不必每次重新下载。</p></div><TechnicalStatusBadge status={compression.status === 'attention' || cache.status === 'attention' ? 'attention' : compression.status === 'confirm' || cache.status === 'confirm' ? 'confirm' : 'good'} /></div>
        <div className="technical-split">
          <div><span className="technical-label">传输压缩</span><p>{compression.explanation}</p></div>
          <div><span className="technical-label">浏览器缓存</span><p>{cache.explanation}</p></div>
        </div>
        <details className="technical-details"><summary>查看响应头证据</summary><div className="technical-detail-body"><dl className="data-table">
          <DataRow label="Content-Encoding" value={headerValue(technical.headers.contentEncoding)} code />
          <DataRow label="Content-Length" value={technical.headers.contentLength === null ? '未声明' : formatBytes(technical.headers.contentLength)} />
          <DataRow label="Cache-Control" value={headerValue(technical.headers.cacheControl)} code />
          <DataRow label="ETag" value={headerValue(technical.headers.etag)} code />
          <DataRow label="Last-Modified" value={headerValue(technical.headers.lastModified)} code />
          <DataRow label="Vary" value={headerValue(technical.headers.vary)} code />
        </dl></div></details>
      </section>

      <section className="plain-section technical-section">
        <div className="section-heading"><div><p className="section-kicker">4 · 控制抓取范围</p><h2>抓取规则（robots.txt）</h2><p className="heading-help">robots.txt 管理爬虫可以访问哪些路径，不能用来保护隐私，也不能代替 noindex。</p></div><TechnicalStatusBadge status={robotsStatus} /></div>
        <dl className="data-table">
          <DataRow label="地址" value={siteProbe.robots.url} code />
          <DataRow label="状态" value={siteProbe.robots.status === 404 ? '404（等同没有额外限制，不是故障）' : siteProbe.robots.status ?? '请求失败'} />
          <DataRow label="当前路径" value={siteProbe.robots.allowed === null ? '不可测' : siteProbe.robots.allowed ? '允许抓取' : '阻止抓取'} />
          <DataRow label="声明 Sitemap" value={siteProbe.robots.sitemaps.join(' · ') || '未声明'} code />
          {siteProbe.robots.agentAccess ? <DataRow label="通用 / Google / Bing / 百度" value={[
            siteProbe.robots.agentAccess['*'],
            siteProbe.robots.agentAccess.Googlebot,
            siteProbe.robots.agentAccess.Bingbot,
            siteProbe.robots.agentAccess.Baiduspider,
          ].map((allowed) => allowed ? '允许' : '阻止').join(' / ')} /> : null}
          <DataRow label="被阻止的页面资源" value={siteProbe.robots.blockedResources?.length ? `${siteProbe.robots.blockedResources.length} 个 CSS、JavaScript 或图片候选` : '未发现'} />
          {siteProbe.robots.error ? <DataRow label="错误" value={siteProbe.robots.error} /> : null}
        </dl>
        {siteProbe.robots.syntaxIssues?.length || siteProbe.robots.unknownDirectives?.length || siteProbe.robots.blockedResources?.length ? <details className="technical-details"><summary>查看抓取规则风险证据</summary><div className="technical-detail-body">
          {siteProbe.robots.syntaxIssues?.length ? <div><span className="technical-label">格式风险</span><ul className="clean-list">{siteProbe.robots.syntaxIssues.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
          {siteProbe.robots.unknownDirectives?.length ? <p>需要确认的非标准指令：<code>{siteProbe.robots.unknownDirectives.join('、')}</code></p> : null}
          {siteProbe.robots.blockedResources?.length ? <div className="resource-table">{siteProbe.robots.blockedResources.slice(0, 20).map((item) => <div className="resource-row" key={item.url}><span>{item.kind}</span><code>{item.url}</code><p>受影响：{item.blockedFor.join('、')}</p></div>)}</div> : null}
        </div></details> : null}
        {siteProbe.sitemap ? <details className="technical-details"><summary>查看页面清单（Sitemap）</summary><div className="technical-detail-body"><dl className="data-table"><DataRow label="地址" value={siteProbe.sitemap.url} code /><DataRow label="状态" value={siteProbe.sitemap.status ?? '请求失败'} /><DataRow label="XML" value={siteProbe.sitemap.validXml === null ? '不可测' : siteProbe.sitemap.validXml ? '可解析' : '格式错误'} /><DataRow label="Content-Type" value={siteProbe.sitemap.contentType || '未声明'} code /></dl></div></details> : null}
      </section>

      <section className="plain-section technical-section">
        <div className="section-heading"><div><p className="section-kicker">5 · 比较服务器与浏览器</p><h2>搜索引擎能读到的内容</h2><p className="heading-help">原始 HTML 是服务器先交付的内容，最终 DOM 是 JavaScript 执行后的页面。</p></div><SignalState value={rawComparison.available} /></div>
        <dl className="data-table">
          <DataRow label="原始 Title" value={rawComparison.rawTitle || '缺失 / 不可测'} code />
          <DataRow label="原始 Canonical" value={rawComparison.rawCanonicals.join(' · ') || '缺失 / 不可测'} code />
          <DataRow label="原始 H1" value={rawComparison.available ? rawComparison.rawH1.join(' · ') || '缺失' : '不可测'} />
          <DataRow label="正文" value={rawComparison.available ? `原始 ${rawComparison.rawTextLength.toLocaleString('zh-CN')} · 渲染后 ${rawComparison.renderedTextLength.toLocaleString('zh-CN')} 字符` : '不可测'} />
          <DataRow label="原始内链" value={rawComparison.available ? rawComparison.rawInternalLinks.length : '不可测'} />
          <DataRow label="渲染差异" value={rawComparison.available ? rawComparison.differences.join('、') || '未发现结构差异' : '不可测'} />
        </dl>
      </section>

      <section className="plain-section technical-section">
        <div className="section-heading"><div><p className="section-kicker">6 · 提供机器可读说明</p><h2>结构化数据建议</h2><p className="heading-help">这里只建议与页面真实内容匹配的类型，不保证排名或富结果展示。</p></div><TechnicalStatusBadge status={schemaSuggestions.length ? 'confirm' : 'good'} /></div>
        {schemaSuggestions.length ? <div className="schema-suggestion-list">{schemaSuggestions.map((suggestion) => <details className="technical-details" key={suggestion.schemaType}><summary>{suggestion.schemaType} · {suggestion.reason}</summary><div className="technical-detail-body"><p>需要真实字段：{suggestion.requiredRealFields.join('、')}</p><pre><code>{suggestion.exampleJsonLd}</code></pre><p className="technical-warning">{suggestion.warnings.join('；')}</p></div></details>)}</div> : <p className="technical-conclusion">当前页面已有匹配类型，或页面类型不足以生成可靠建议。</p>}
      </section>

      <section className="plain-section technical-section">
        <div className="section-heading"><div><p className="section-kicker">7 · 找出加载风险</p><h2>CSS 与 JavaScript 加载</h2><p className="heading-help">检测阻塞、重复和第三方资源；没有调试权限时不会武断地说某段代码可以删除。</p></div><TechnicalStatusBadge status={resources.blockingScripts || resources.duplicateUrls.length || resources.blockingStylesheets > 4 ? 'confirm' : 'good'} /></div>
        <div className="technical-metrics"><span>{resources.total}<small>资源</small></span><span>{resources.blockingScripts}<small>同步脚本</small></span><span>{resources.blockingStylesheets}<small>阻塞样式</small></span><span>{resources.thirdParty}<small>第三方</small></span></div>
        <p className="technical-conclusion">本次可测传输量 {formatBytes(resources.transferBytes)}；{resources.unmeasurableSizes} 个资源因缓存或跨域限制无法取得体积。{enrichedResources.length ? `完整入口检查还抽样读取了 ${enrichedResources.length} 个同源 CSS/JS 响应头，发现 ${resourceCompressionRisks} 个压缩风险、${resourceCacheRisks} 个缓存风险。` : ''}</p>
        <details className="technical-details"><summary>查看资源候选</summary><div className="technical-detail-body resource-table">{resources.resources.filter((item) => item.kind === 'script' || item.kind === 'stylesheet').slice(0, 40).map((item, index) => <div className="resource-row" key={`${item.url}-${index}`}><span>{item.kind === 'script' ? 'JS' : 'CSS'}</span><code>{item.inline ? '内联资源' : item.url}</code><p>{item.blocking ? '阻塞候选' : item.module ? 'module' : item.async ? 'async' : item.defer ? 'defer' : '非阻塞'} · {formatBytes(item.transferSize)}{item.compression ? ` · ${item.compression.explanation}` : ''}</p></div>)}</div></details>
      </section>

      <section className="plain-section technical-section">
        <div className="section-heading"><div><p className="section-kicker">8 · 检查链接关系</p><h2>链接关系（nofollow）</h2><p className="heading-help">nofollow 是关系提示，不是隐藏页面或站内“权重雕刻”工具。</p></div><TechnicalStatusBadge status={links.pageNofollow || links.internalNofollow ? 'confirm' : 'good'} /></div>
        <dl className="data-table"><DataRow label="页面级 nofollow" value={links.pageNofollow ? '已声明' : '未声明'} /><DataRow label="内部 nofollow" value={links.internalNofollow} /><DataRow label="外部 nofollow" value={links.externalNofollow} /><DataRow label="ugc / sponsored" value={`${links.ugc} / ${links.sponsored}`} /></dl>
        <p className="section-note">普通自然外链不需要机械添加 nofollow；付费关系使用 sponsored，用户生成内容使用 ugc，并结合真实关系决定是否同时 nofollow。</p>
      </section>

      <section className="plain-section limitations technical-section">
        <div className="section-heading"><div><p className="section-kicker">9 · 防止过度解读</p><h2>检测边界</h2></div><ShieldAlert size={18} /></div>
        <ul className="clean-list">{[...report.snapshot.limitations, ...technical.limitations].map((item) => <li key={item}>{item}</li>)}</ul>
      </section>
    </div>
  );
}

const AI_SUGGESTED_QUESTIONS = [
  '按 P0 到 P3 告诉我应该先修什么，并给出执行顺序。',
  '把当前问题整理成开发可以直接执行的修改清单。',
  '重点解释性能指标的问题、原因和验证方法。',
  '基于当前证据制定一个 7 天 SEO 优化计划。',
];

function AiMarkdown({ content }: { content: string }) {
  return (
    <Suspense fallback={<p className="ai-rendering-placeholder">正在整理回答…</p>}>
      <LazyAiMarkdown content={content} />
    </Suspense>
  );
}

function AiChatView({
  report,
  conversation,
  streamingAnswer,
  loading,
  error,
  configured,
  hasKey,
  onSend,
  onCancel,
  onDismissError,
  onSave,
  onClear,
  onOpenSettings,
}: {
  report: AuditReport;
  conversation: AiConversation | null;
  streamingAnswer: string;
  loading: boolean;
  error: string;
  configured: boolean;
  hasKey: boolean;
  onSend: (content: string) => Promise<void>;
  onCancel: () => Promise<void>;
  onDismissError: () => void;
  onSave: (conversation: AiConversation) => Promise<void>;
  onClear: () => Promise<void>;
  onOpenSettings: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [lastSubmitted, setLastSubmitted] = useState('');
  const [pendingMessage, setPendingMessage] = useState<{ content: string; createdAt: string } | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [savingConversation, setSavingConversation] = useState(false);
  const [conversationSaved, setConversationSaved] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const entries = conversation?.entries ?? [];

  useEffect(() => {
    requestAnimationFrame(() => {
      const timeline = timelineRef.current;
      if (timeline) timeline.scrollTop = timeline.scrollHeight;
    });
  }, [entries.length, loading, pendingMessage?.content, streamingAnswer]);

  useEffect(() => {
    if (!loading) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [loading]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 72), 160)}px`;
  }, [draft]);

  useEffect(() => {
    setDraft('');
    setLastSubmitted('');
    setPendingMessage(null);
  }, [report.id]);

  useEffect(() => {
    setConversationSaved(false);
  }, [conversation?.updatedAt]);

  const submit = async (value?: string) => {
    const content = (value ?? draft).trim();
    if (!content || loading || report.stale || !configured) return;
    setLastSubmitted(content);
    if (value === undefined) setDraft('');
    setPendingMessage({ content, createdAt: new Date().toISOString() });
    onDismissError();
    requestAnimationFrame(() => textareaRef.current?.focus());
    try {
      await onSend(content);
      setPendingMessage(null);
    } catch {
      setPendingMessage(null);
      setDraft((current) => current.trim() ? current : content);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  const saveConversation = async () => {
    if (!conversation || entries.length === 0 || loading || savingConversation) return;
    setSavingConversation(true);
    try {
      await onSave(conversation);
      setConversationSaved(true);
    } finally {
      setSavingConversation(false);
    }
  };

  return (
    <div className="ai-chat-view">
      <section className="ai-chat-header" aria-labelledby="ai-chat-title">
        <span className="playful-icon ai-icon" aria-hidden="true"><Sparkles size={20} /></span>
        <div>
          <p className="section-kicker">可选 AI · 不影响页面 SEO 基础分</p>
          <h2 id="ai-chat-title">AI 深度解读</h2>
          <p>{formatUrl(report.url)} · 证据更新于 {formatTime(report.createdAt)}</p>
        </div>
        <div className="ai-chat-actions">
          <button
            type="button"
            className={`ai-save-button ${conversationSaved ? 'saved' : ''}`}
            onClick={() => void saveConversation()}
            disabled={loading || savingConversation || entries.length === 0}
            aria-label="保存当前网站对话"
          >
            {savingConversation ? <LoaderCircle className="spinner" size={15} /> : conversationSaved ? <Check size={15} /> : <Save size={15} />}
            {conversationSaved ? '已保存' : '保存对话'}
          </button>
          <IconButton label="AI 设置" onClick={onOpenSettings} disabled={loading}>
            <Settings size={18} />
          </IconButton>
          {entries.length > 0 ? (
            <IconButton label="清空当前网站对话" onClick={() => void onClear()} disabled={loading}>
              <Trash2 size={18} />
            </IconButton>
          ) : null}
        </div>
      </section>

      {!configured ? (
        <section className="ai-setup-state" role="status">
          <span className="playful-icon" aria-hidden="true"><KeyRound size={22} /></span>
          <h2>{hasKey ? '还需要请求地址和模型' : '先配置你的 AI 服务'}</h2>
          <p>{hasKey
            ? '请在设置中补全请求地址和模型，保存后即可开始对话。'
            : '填写请求地址、模型和 API Key 后自动启用；AI 建议不会改变规则结果或页面 SEO 基础分。'}</p>
          <button type="button" className="primary-button" onClick={onOpenSettings}>
            <Settings size={17} />配置并保存 AI
          </button>
        </section>
      ) : (
        <>
          <div className="ai-context-note">
            <Info size={16} aria-hidden="true" />
            <span>每轮都会携带最新评分、全部规则证据、页面与站点信号、性能和数据缺口；不会发送完整 DOM、Cookie 或表单值。</span>
          </div>

          <div className="ai-timeline" ref={timelineRef} aria-live="polite" aria-label="AI 对话记录" aria-busy={loading}>
            {entries.length === 0 && !pendingMessage ? (
              <div className="ai-welcome">
                <span className="playful-icon" aria-hidden="true"><MessageCircle size={22} /></span>
                <h2>从当前审计继续追问</h2>
                <p>可以问执行顺序、代码修改、性能瓶颈或验证方法。</p>
                <div className="ai-suggestions">
                  {AI_SUGGESTED_QUESTIONS.map((question) => (
                    <button type="button" key={question} onClick={() => void submit(question)} disabled={report.stale || loading}>
                      <span>{question}</span><ArrowRight size={16} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            ) : entries.map((entry: AiChatEntry) => (
              'type' in entry ? (
                <div className="ai-context-event" key={entry.id}>
                  <span>证据已更新</span>
                  <span>{formatTime(entry.createdAt)} · {formatUrl(entry.url)}</span>
                </div>
              ) : (
                <article className={`ai-message ai-message-${entry.role}`} key={entry.id}>
                  <div className="ai-message-meta">
                    <span>{entry.role === 'user' ? '你' : 'AI 建议'}</span>
                    <time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>
                  </div>
                  <div className="ai-message-content">
                    {entry.role === 'assistant' ? <AiMarkdown content={entry.content} /> : <p>{entry.content}</p>}
                  </div>
                </article>
              )
            ))}
            {pendingMessage ? (
              <article className="ai-message ai-message-user ai-message-pending">
                <div className="ai-message-meta">
                  <span>你 · 已发送</span>
                  <time dateTime={pendingMessage.createdAt}>{formatTime(pendingMessage.createdAt)}</time>
                </div>
                <div className="ai-message-content"><p>{pendingMessage.content}</p></div>
              </article>
            ) : null}
            {loading && streamingAnswer ? (
              <article className="ai-message ai-message-assistant ai-message-streaming" role="status">
                <div className="ai-message-meta">
                  <span>AI 建议 · 生成中</span>
                  <span className="ai-streaming-label">实时输出</span>
                </div>
                <div className="ai-message-content">
                  <AiMarkdown content={streamingAnswer} />
                  <span className="ai-streaming-caret" aria-hidden="true" />
                </div>
              </article>
            ) : null}
            {loading && !streamingAnswer ? (
              <div className="ai-message ai-message-assistant ai-message-loading" role="status">
                <span className="ai-loading-indicator" aria-hidden="true"><LoaderCircle className="spinner" size={18} /></span>
                <span className="ai-loading-copy">
                  <span>{elapsedSeconds >= 30 ? '模型仍在处理，请继续等待...' : '正在结合最新审计证据回答...'}</span>
                  <span>已等待 {elapsedSeconds} 秒 · 最长等待 120 秒，可随时停止</span>
                </span>
              </div>
            ) : null}
          </div>

          {report.stale ? (
            <div className="notice warning-notice"><AlertCircle size={17} /><span>页面信息已经过期，请重新扫描后继续对话。</span></div>
          ) : null}

          {error ? (
            <div className="notice error-notice ai-chat-error" role="alert">
              <AlertCircle size={17} />
              <span>{error}</span>
              <div className="ai-chat-error-actions">
                {lastSubmitted && !loading ? (
                  <button type="button" className="text-button" onClick={() => void submit(lastSubmitted)} disabled={report.stale}>重试上条</button>
                ) : null}
                <IconButton label="关闭 AI 错误" onClick={onDismissError}><X size={16} /></IconButton>
              </div>
            </div>
          ) : null}

          <form className="ai-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <label htmlFor="ai-question">继续追问</label>
            <textarea
              ref={textareaRef}
              id="ai-question"
              value={draft}
              maxLength={2_000}
              placeholder="例如：先修哪三个问题，怎么验证？"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                if (loading) return;
                event.preventDefault();
                void submit();
              }}
              disabled={report.stale}
              aria-describedby="ai-composer-help"
            />
            <div className="ai-composer-footer">
              <span id="ai-composer-help">{draft.length}/2000 · {loading ? '回答生成中，可先编辑下一条' : 'Enter 发送，Shift+Enter 换行'}</span>
              <div>
                {lastSubmitted && !loading && !error ? (
                  <button type="button" className="text-button" onClick={() => void submit(lastSubmitted)} disabled={report.stale}>
                    重试
                  </button>
                ) : null}
                {loading ? (
                  <button type="button" className="ai-stop-button" onClick={() => void onCancel()}>
                    <Square size={15} fill="currentColor" />停止
                  </button>
                ) : (
                  <button type="submit" className="ai-send-button" disabled={!draft.trim() || report.stale}>
                    <Send size={17} />发送
                  </button>
                )}
              </div>
            </div>
          </form>
        </>
      )}
    </div>
  );
}

function LoadingView() {
  return (
    <div className="loading-view" role="status" aria-live="polite">
      <LoaderCircle className="spinner" size={30} />
      <h2>正在读取页面信号</h2>
      <p>检查最终 DOM、真实 GET、robots.txt、Sitemap 和本次访问性能。</p>
      <div className="skeleton-lines" aria-hidden="true"><span /><span /><span /></div>
    </div>
  );
}

function EmptyView({
  state,
  onScan,
  onGrantPageAccess,
}: {
  state: ScanState;
  onScan: () => void;
  onGrantPageAccess: () => void;
}) {
  const isUnsupported = state.status === 'unsupported';
  const isPermissionRequired = state.status === 'permission_required';
  const isError = state.status === 'error';
  let message = '打开一个普通网页，然后扫描当前页面。';
  if (state.status === 'unsupported' || state.status === 'permission_required') message = state.reason;
  else if (state.status === 'error') message = state.message;
  return (
    <div className="empty-state initial-empty" role={isError ? 'alert' : 'status'}>
      {isUnsupported ? <ShieldAlert size={32} /> : isPermissionRequired ? <MousePointerClick size={32} /> : isError ? <AlertCircle size={32} /> : <ScanSearch size={32} />}
      <h2>{isUnsupported ? '当前页面不可测' : isPermissionRequired ? '需要授权当前页面' : isError ? '扫描没有完成' : '开始页面审计'}</h2>
      <p>{message}</p>
      {isPermissionRequired ? (
        <button type="button" className="primary-button" onClick={onGrantPageAccess}>
          <Globe2 size={18} />允许检测当前网站
        </button>
      ) : !isUnsupported ? (
        <button type="button" className="primary-button" onClick={onScan}>
          <ScanSearch size={18} />扫描当前页面
        </button>
      ) : null}
      <p className="empty-note">
        {isPermissionRequired
          ? '只授权当前网站，之后可以直接扫描和重新扫描；也可以只用工具栏图标的临时授权。'
          : '支持 HTTP/HTTPS 顶层页面；不读取跨域 iframe、closed shadow root、Cookie 或表单值。'}
      </p>
    </div>
  );
}

function SettingsDialog({
  open,
  preferences,
  hasApiKey,
  onClose,
  onSave,
  onClearAllAi,
  onClearAiKey,
  onClearAllLocalData,
}: {
  open: boolean;
  preferences: UserPreferences;
  hasApiKey: boolean;
  onClose: () => void;
  onSave: (preferences: UserPreferences, apiKey: string) => Promise<void>;
  onClearAllAi: () => Promise<void>;
  onClearAiKey: () => Promise<void>;
  onClearAllLocalData: () => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(preferences);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const recognizedEndpoint = useMemo(() => {
    if (!draft.ai.endpoint.trim()) return null;
    try {
      return { url: normalizeAiEndpoint(draft.ai.endpoint).href, error: '' };
    } catch (endpointError) {
      return {
        url: '',
        error: endpointError instanceof Error ? endpointError.message : '请求地址无法识别。',
      };
    }
  }, [draft.ai.endpoint]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setDraft(preferences);
      setApiKey('');
      setShowKey(false);
      setError('');
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, preferences]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await onSave(draft, apiKey);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存设置失败。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-header">
        <div className="dialog-title-block">
          <span className="playful-icon dialog-icon" aria-hidden="true"><Settings size={20} /></span>
          <div><p className="section-kicker">本地偏好</p><h2>设置</h2></div>
        </div>
        <IconButton label="关闭设置" onClick={onClose}><X size={19} /></IconButton>
      </div>
      <div className="dialog-body">
        <fieldset className="settings-section ai-settings">
          <legend>可选 AI</legend>
          <div className="ai-fields">
            <div className="notice info-notice">
              <Info size={17} />
              <span>填写请求地址、模型和 API Key 后自动启用。优先使用 OpenAI-compatible <code>/chat/completions</code> 的 SSE 流式请求，也兼容非流式 JSON，AI 建议不会改变规则结果或页面 SEO 基础分。</span>
            </div>
            <label className="field-label" htmlFor="ai-endpoint">
              请求地址
              <input
                id="ai-endpoint"
                type="url"
                value={draft.ai.endpoint}
                placeholder="https://codecc.cc/v1"
                onChange={(event) => setDraft({ ...draft, ai: { ...draft.ai, endpoint: event.target.value } })}
                autoComplete="url"
              />
              <span className="field-help">支持填写域名、<code>/v1</code> 或完整 <code>/chat/completions</code>；保存时会统一识别。</span>
              <span className="field-help">远程地址必须使用 HTTPS；localhost 和 127.0.0.1 可使用 HTTP。</span>
              {recognizedEndpoint ? (
                <span className={`endpoint-recognition ${recognizedEndpoint.error ? 'recognition-error' : ''}`} role="status">
                  {recognizedEndpoint.error ? <AlertCircle size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
                  <span>{recognizedEndpoint.error || '实际请求：'}{recognizedEndpoint.url ? <code>{recognizedEndpoint.url}</code> : null}</span>
                </span>
              ) : null}
              <a className="provider-link" href="https://codecc.cc" target="_blank" rel="noreferrer noopener">
                <ExternalLink size={15} aria-hidden="true" />获取 API Key
              </a>
            </label>
            <label className="field-label" htmlFor="ai-model">
              模型
              <input
                id="ai-model"
                value={draft.ai.model}
                placeholder="例如：gpt-4.1-mini"
                onChange={(event) => setDraft({ ...draft, ai: { ...draft.ai, model: event.target.value } })}
                autoComplete="off"
              />
            </label>
            <label className="field-label" htmlFor="ai-key">
              API Key（保存在此浏览器）
              <span className="input-with-action">
                <KeyRound size={17} aria-hidden="true" />
                <input
                  id="ai-key"
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  placeholder={hasApiKey ? '已保存；输入新 Key 可替换' : '填写 API Key'}
                  onChange={(event) => setApiKey(event.target.value)}
                  autoComplete="off"
                />
                <button type="button" onClick={() => setShowKey((value) => !value)} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} title={showKey ? '隐藏 API Key' : '显示 API Key'}>
                  {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </span>
            </label>
            <div className={`key-storage-status ${hasApiKey ? 'has-key' : ''}`} role="status">
              <span className="key-storage-icon" aria-hidden="true">{hasApiKey ? <Check size={17} /> : <KeyRound size={17} />}</span>
              <span>
                <span className="key-storage-title">{hasApiKey ? 'API Key 已保存在本机' : '尚未保存 API Key'}</span>
                <span className="key-storage-note">{apiKey
                  ? '保存设置后将使用刚填写的新 Key。'
                  : hasApiKey
                    ? '浏览器重启后仍可使用；扩展不会在界面回显明文。'
                    : '填写后点击下方“保存设置”。'}</span>
              </span>
              {hasApiKey ? (
                <button type="button" className="text-button key-clear-button" onClick={() => void onClearAiKey()} disabled={saving}>
                  <Trash2 size={15} />清除 Key
                </button>
              ) : null}
            </div>
            <p className="privacy-copy">Key、对话历史和 AI 配置保存在当前 Chrome 用户的扩展本地存储中，可随时手动清除。仅在你发送问题时传输审计证据和最多 4000 字可见正文；不发送完整 DOM、Cookie、网页本地存储或表单值。</p>
            <div className="ai-storage-actions">
            <button type="button" className="text-button ai-clear-all" onClick={() => void onClearAllAi()} disabled={saving}>
              <Trash2 size={16} />清除全部 AI 对话
            </button>
            <button type="button" className="text-button ai-clear-all" onClick={() => void onClearAllLocalData()} disabled={saving}>
              <Trash2 size={16} />清除全部本地数据
            </button>
            </div>
          </div>
        </fieldset>
        {error ? <div className="notice error-notice" role="alert"><AlertCircle size={17} /><span>{error}</span></div> : null}
      </div>
      <div className="dialog-footer">
        <button type="button" className="text-button" onClick={onClose} disabled={saving}>取消</button>
        <button type="button" className="primary-button dialog-save-button" onClick={() => void save()} disabled={saving}>
          {saving ? <LoaderCircle className="spinner" size={17} /> : <Check size={17} />}
          保存设置
        </button>
      </div>
    </dialog>
  );
}

export function App() {
  const [view, setView] = useState<ViewId>('overseas');
  const [scanState, setScanState] = useState<ScanState>({ status: 'idle', tabId: null });
  const [activeStateLoaded, setActiveStateLoaded] = useState(false);
  const [preferences, setPreferencesState] = useState<UserPreferences>(DEFAULT_PREFERENCES);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [aiConversation, setAiConversation] = useState<AiConversation | null>(null);
  const [hasAiKey, setHasAiKey] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiStreamingAnswer, setAiStreamingAnswer] = useState('');
  const [aiError, setAiError] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeAiRequestRef = useRef<string | null>(null);
  const cancelledAiRequestsRef = useRef(new Set<string>());

  const report = scanState.status === 'ready' ? scanState.report : null;

  const refreshState = useCallback(async () => {
    try {
      const state = await rpc<ScanState>({ type: 'GET_ACTIVE_STATE' });
      setScanState(state);
      if (state.status === 'ready') {
        if (state.report.stale) setOverlayVisible(false);
        const savedConversation = await rpc<AiConversation | null>({ type: 'GET_AI_CONVERSATION', origin: new URL(state.report.url).origin });
        setAiConversation(savedConversation);
      } else {
        setAiConversation(null);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '无法读取扫描状态。');
    } finally {
      setActiveStateLoaded(true);
    }
  }, []);

  useEffect(() => {
    void Promise.all([
      refreshState(),
      rpc<UserPreferences>({ type: 'GET_PREFERENCES' }).then(setPreferencesState),
      rpc<{ hasKey: boolean }>({ type: 'GET_AI_KEY_STATUS' }).then(({ hasKey }) => setHasAiKey(hasKey)),
    ]);
    const listener = (message: RuntimeMessage) => {
      if (message.type === 'OPEN_OVERSEAS_WORKSPACE') setView('overseas');
      if (message.type === 'SCAN_STATE_CHANGED') void refreshState();
      if (
        message.type === 'AI_MESSAGE_DELTA'
        && activeAiRequestRef.current === message.requestId
        && !cancelledAiRequestsRef.current.has(message.requestId)
      ) {
        setAiStreamingAnswer((current) => current + message.delta);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [refreshState]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 3200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    setAiError('');
  }, [report?.id]);

  const startScan = async (context = report?.context) => {
    setError('');
    setOverlayVisible(false);
    setSelectedIssueId(null);
    setScanState({ status: 'scanning', tabId: report?.tabId ?? 0, startedAt: new Date().toISOString() });
    try {
      const state = await rpc<ScanState>({
        type: 'START_SCAN',
        ...(context ? { context } : {}),
        ...(report?.url ? { url: report.url } : {}),
      });
      setScanState(state);
      if (context && state.status === 'ready') setNotice('页面已重新扫描，页面目标已保留');
    } catch (scanError) {
      setScanState({ status: 'error', tabId: report?.tabId ?? null, message: scanError instanceof Error ? scanError.message : '扫描失败。' });
    }
  };

  useEffect(() => {
    if (!activeStateLoaded || view !== 'overseas') return;
    if (scanState.status === 'idle') void startScan();
  }, [activeStateLoaded, view, scanState.status]);

  const grantPageAccess = async () => {
    setError('');
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.url || !/^https?:\/\//i.test(tab.url)) throw new Error('当前标签页不是可授权的普通网页。');
      const granted = await chrome.permissions.request({ origins: [originPermissionPattern(tab.url)] });
      if (!granted) {
        setError('未获得当前网站读取权限。你仍可以点击浏览器工具栏中的“SEO优化”图标临时授权。');
        return;
      }
      await startScan();
    } catch (permissionError) {
      setError(permissionError instanceof Error ? permissionError.message : '无法申请网页读取权限。');
    }
  };

  const showAllOverlays = async () => {
    if (!report) return;
    setError('');
    try {
      if (overlayVisible) {
        await rpc({ type: 'CLEAR_OVERLAY' });
        setOverlayVisible(false);
      } else {
        await rpc({ type: 'SHOW_OVERLAY', findings: report.findings, selectedId: null, scroll: false });
        setOverlayVisible(true);
      }
    } catch (overlayError) {
      setError(overlayError instanceof Error ? overlayError.message : '无法显示网页标注。');
    }
  };

  const locateFinding = async (finding: AuditFinding) => {
    if (!report) return;
    if (report.stale) {
      setError('页面已经变化，请重新扫描后再定位元素。');
      return;
    }
    setError('');
    try {
      await rpc({ type: 'SHOW_OVERLAY', findings: report.findings, selectedId: finding.id, scroll: true });
      setOverlayVisible(true);
    } catch (locateError) {
      setError(locateError instanceof Error ? locateError.message : '目标元素已失效，请重新扫描。');
    }
  };

  const saveSettings = async (next: UserPreferences, apiKey: string) => {
    const normalizedPreferences: UserPreferences = {
      ai: {
        endpoint: next.ai.endpoint.trim(),
        model: next.ai.model.trim(),
      },
    };
    let previousOrigin: string | null = null;
    if (preferences.ai.endpoint) {
      try {
        previousOrigin = permissionPatternForEndpoint(preferences.ai.endpoint);
      } catch {
        // Invalid legacy settings must not prevent the user from disabling AI.
      }
    }
    if (normalizedPreferences.ai.endpoint) {
      const origin = permissionPatternForEndpoint(normalizedPreferences.ai.endpoint);
      const granted = await chrome.permissions.contains({ origins: [origin] });
      if (!granted) {
        const accepted = await chrome.permissions.request({ origins: [origin] });
        if (!accepted) throw new Error('未获得该 AI 主机权限，请允许后再使用 AI。');
      }
      if (previousOrigin && previousOrigin !== origin) await chrome.permissions.remove({ origins: [previousOrigin] });
    } else if (previousOrigin) {
      await chrome.permissions.remove({ origins: [previousOrigin] });
    }
    await rpc({ type: 'SAVE_PREFERENCES', preferences: normalizedPreferences });
    if (apiKey.trim()) {
      await rpc({ type: 'SAVE_AI_KEY', apiKey });
      setHasAiKey(true);
    }
    setPreferencesState(normalizedPreferences);
    setNotice('设置已保存');
  };

  const clearAiKey = async () => {
    if (!window.confirm('清除保存在此浏览器中的 API Key？清除后需要重新填写才能使用 AI。')) return;
    await rpc({ type: 'CLEAR_AI_KEY' });
    setHasAiKey(false);
    setNotice('本地 API Key 已清除');
  };

  const sendAiMessage = async (content: string) => {
    if (!report) return;
    const requestId = crypto.randomUUID();
    activeAiRequestRef.current = requestId;
    setAiLoading(true);
    setAiError('');
    setAiStreamingAnswer('');
    try {
      const result = await rpc<AiChatReply>({ type: 'SEND_AI_MESSAGE', requestId, report, content });
      setAiConversation(result.conversation);
    } catch (aiError) {
      const message = aiError instanceof Error ? aiError.message : 'AI 请求失败。';
      const cancelled = cancelledAiRequestsRef.current.has(requestId) || message === 'AI 请求已停止。';
      if (!cancelled) setAiError(message);
      throw aiError;
    } finally {
      cancelledAiRequestsRef.current.delete(requestId);
      if (activeAiRequestRef.current === requestId) {
        activeAiRequestRef.current = null;
        setAiLoading(false);
      }
      setAiStreamingAnswer('');
    }
  };

  const cancelAiMessage = async () => {
    const requestId = activeAiRequestRef.current;
    if (!requestId) return;
    cancelledAiRequestsRef.current.add(requestId);
    try {
      const result = await rpc<{ cancelled: boolean }>({ type: 'CANCEL_AI_MESSAGE', requestId });
      if (result.cancelled) setNotice('已停止本轮 AI 回答，问题已保留可重新发送');
      else cancelledAiRequestsRef.current.delete(requestId);
    } catch (cancelError) {
      cancelledAiRequestsRef.current.delete(requestId);
      setAiError(cancelError instanceof Error ? cancelError.message : '无法停止当前 AI 请求。');
    }
  };

  const saveAiConversation = async (conversation: AiConversation) => {
    try {
      const saved = await rpc<AiConversation>({ type: 'SAVE_AI_CONVERSATION', conversation });
      setAiConversation(saved);
      setNotice('当前网站 AI 对话已保存到本机');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存 AI 对话失败。');
    }
  };

  const clearAiConversation = async () => {
    if (!report || !window.confirm('清除当前网站的 AI 对话？此操作无法恢复。')) return;
    await rpc({ type: 'CLEAR_AI_CONVERSATION', origin: new URL(report.url).origin });
    setAiConversation(null);
    setAiError('');
    setNotice('当前网站的 AI 对话已清除');
  };

  const clearAllAiConversations = async () => {
    if (!window.confirm('清除所有网站的 AI 对话？此操作无法恢复。')) return;
    await rpc({ type: 'CLEAR_ALL_AI_CONVERSATIONS' });
    setAiConversation(null);
    setNotice('所有 AI 对话已清除');
  };

  const clearAllLocalData = async () => {
    if (!window.confirm('清除全部本地数据？这会删除搜索项目、规范化 CSV、站点审计、复测基线、AI 配置、API Key、对话和页面会话结果，且无法恢复。')) return;
    await clearAllProjectData();
    await Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]);
    setPreferencesState(DEFAULT_PREFERENCES);
    setHasAiKey(false);
    setAiConversation(null);
    setScanState({ status: 'idle', tabId: null });
    setSettingsOpen(false);
    setNotice('全部本地数据已清除');
  };

  const aiConfigured = Boolean(
    preferences.ai.endpoint.trim()
      && preferences.ai.model.trim()
      && hasAiKey,
  );

  const copyReport = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(reportToMarkdown(report));
      setNotice('Markdown 报告已复制');
    } catch {
      setError('无法写入剪贴板，请检查浏览器权限。');
    }
  };

  const renderView = () => {
    if (view === 'sem') return <Suspense fallback={<div className="loading-view" role="status"><LoaderCircle className="spin" size={28} /><p>正在打开 SEM 工作台</p></div>}><LazySemWorkspace report={report} /></Suspense>;
    if (view === 'overseas') return <Suspense fallback={<div className="loading-view" role="status"><LoaderCircle className="spin" size={28} /><p>正在打开海外站优化</p></div>}><LazyOverseasWorkspace report={report} scanState={scanState} onScan={startScan} onGrantPageAccess={grantPageAccess} /></Suspense>;
    if (!report) return null;
    if (view === 'recommendations') {
      return (
        <RecommendationsView
          report={report}
          onLocate={locateFinding}
          onOpenIssue={(finding) => {
            setSelectedIssueId(finding.id);
            setView('issues');
          }}
        />
      );
    }
    if (view === 'issues') return <IssuesView report={report} onLocate={locateFinding} initialExpandedId={selectedIssueId} />;
    if (view === 'ai') {
      return (
        <AiChatView
          report={report}
          conversation={aiConversation}
          streamingAnswer={aiStreamingAnswer}
          loading={aiLoading}
          error={aiError}
          configured={aiConfigured}
          hasKey={hasAiKey}
          onSend={sendAiMessage}
          onCancel={cancelAiMessage}
          onDismissError={() => setAiError('')}
          onSave={saveAiConversation}
          onClear={clearAiConversation}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      );
    }
    return (
      <Overview
        report={report}
        onContextUpdated={(next) => setScanState({ status: 'ready', tabId: next.tabId, report: next })}
        onRescan={async (context) => { await startScan(context); }}
        onOpenIssue={(finding) => {
          setSelectedIssueId(finding.id);
          setView('issues');
        }}
      />
    );
  };

  const moveTabFocus = (index: number) => {
    const item = VIEW_ITEMS[index];
    if (!item) return;
    setView(item.id);
    requestAnimationFrame(() => tabRefs.current[index]?.focus());
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true"><ScanSearch size={21} /></span>
          <div><h1>SEO优化</h1><p>页面审计工作台</p></div>
        </div>
        <div className="header-actions">
          <IconButton label="重新扫描当前页面" onClick={() => void startScan()} disabled={scanState.status === 'scanning'}>
            <RefreshCw className={scanState.status === 'scanning' ? 'spinner' : ''} size={19} />
          </IconButton>
          <IconButton label={overlayVisible ? '清除网页标注' : '显示网页标注'} onClick={() => void showAllOverlays()} disabled={!report || report.stale} pressed={overlayVisible}>
            <Focus size={19} />
          </IconButton>
          <IconButton label="设置" onClick={() => setSettingsOpen(true)}><Settings size={19} /></IconButton>
        </div>
      </header>

      <nav className="view-tabs" role="tablist" aria-label="搜索增长工作台">
          {VIEW_ITEMS.map(({ id, label, shortLabel, icon: Icon }, index) => (
            <button
              ref={(element) => { tabRefs.current[index] = element; }}
              type="button"
              role="tab"
              id={`view-tab-${id}`}
              aria-label={label}
              aria-controls="view-panel"
              aria-selected={view === id}
              tabIndex={view === id ? 0 : -1}
              key={id}
              className={view === id ? 'active' : ''}
              onClick={() => setView(id)}
              onKeyDown={(event) => {
                let nextIndex: number | null = null;
                if (event.key === 'ArrowRight') nextIndex = (index + 1) % VIEW_ITEMS.length;
                else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + VIEW_ITEMS.length) % VIEW_ITEMS.length;
                else if (event.key === 'Home') nextIndex = 0;
                else if (event.key === 'End') nextIndex = VIEW_ITEMS.length - 1;
                if (nextIndex === null) return;
                event.preventDefault();
                moveTabFocus(nextIndex);
              }}
            >
              <span className="tab-icon" aria-hidden="true"><Icon size={17} /></span>
              <span className="tab-label-full">{label}</span><span className="tab-label-short">{shortLabel}</span>
            </button>
          ))}
        </nav>

      <main className="app-main" id="view-panel" role="tabpanel" aria-labelledby={`view-tab-${view}`}>
        {report?.stale ? <div className="notice warning-notice global-notice" role="status"><AlertCircle size={18} /><span>页面已导航或重新加载，当前结果可能过期。请重新扫描后再修改。</span></div> : null}
        {error ? <div className="notice error-notice global-notice" role="alert"><AlertCircle size={18} /><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="关闭错误"><X size={16} /></button></div> : null}
        {scanState.status === 'scanning' && view !== 'overseas' ? <LoadingView /> : report || view === 'overseas' || view === 'sem' ? renderView() : <EmptyView state={scanState} onScan={() => void startScan()} onGrantPageAccess={() => void grantPageAccess()} />}
      </main>

      {report ? (
        <footer className="action-bar">
          <div className="report-actions">
            <IconButton label="复制 Markdown 报告" onClick={() => void copyReport()}><Copy size={18} /></IconButton>
            <IconButton label="导出 JSON 报告" onClick={() => downloadJson(report)}><Download size={18} /></IconButton>
          </div>
        </footer>
      ) : null}

      <SettingsDialog
        open={settingsOpen}
        preferences={preferences}
        hasApiKey={hasAiKey}
        onClose={() => setSettingsOpen(false)}
        onSave={saveSettings}
        onClearAllAi={clearAllAiConversations}
        onClearAiKey={clearAiKey}
        onClearAllLocalData={clearAllLocalData}
      />
      <div className="toast-region" aria-live="polite" aria-atomic="true">
        {notice ? <div className="toast"><Check size={16} />{notice}</div> : null}
      </div>
    </div>
  );
}
