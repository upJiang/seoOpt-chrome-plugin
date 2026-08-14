import {
  Activity,
  AlertCircle,
  BarChart3,
  Check,
  ChevronDown,
  CircleHelp,
  FileSpreadsheet,
  Globe2,
  Languages,
  Lightbulb,
  ListChecks,
  Play,
  Radio,
  RotateCw,
  ShieldCheck,
  Square,
  Trash2,
} from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { buildOverseasOptimizationRecommendations } from '../../src/lib/audit/recommendations';
import type { AuditReport, RuntimeMessage, ScanState } from '../../src/lib/audit/types';
import { buildOverseasSummary } from '../../src/lib/overseas/diagnostics';
import { originPermissionPattern } from '../../src/lib/page-access';
import {
  clearOverseasProjectData,
  createProjectForOrigin,
  deleteDataset,
  deleteTrackingRun,
  latestOverseasReport,
  listDatasets,
  listTrackingRuns,
  saveProject,
} from '../../src/lib/projects/db';
import type {
  ImportDataset,
  OverseasDiagnosticFinding,
  OverseasSignalStatus,
  OverseasStaticSnapshot,
  OverseasSummary,
  SearchProject,
  TrackingReconciliationReport,
  TrackingTestRun,
} from '../../src/lib/projects/types';
import { CsvImporter } from './CsvImporter';
import { RecommendationSolutions } from './RecommendationSolutions';
import { SelectField } from './SelectField';

type Section = 'summary' | 'issues' | 'recommendations' | 'tracking';
interface RpcResponse<T> { ok: boolean; result?: T; error?: string }

const SECTIONS = [
  ['summary', '概况', Globe2],
  ['issues', '问题', ListChecks],
  ['recommendations', '优化建议', Lightbulb],
  ['tracking', '追踪', Radio],
] as const;

const STATUS_LABELS: Record<OverseasSignalStatus, string> = {
  normal: '正常', attention: '需要处理', confirm: '需要确认', unavailable: '无法检测', untested: '尚未测试',
};
const PLATFORM_LABELS = {
  google_analytics: 'GA4', google_tag_manager: 'Google Tag Manager', google_ads: 'Google Ads', bing_uet: 'Bing UET', microsoft_clarity: 'Clarity',
} as const;
const GOAL_OPTIONS = [
  { value: 'lead', label: '咨询或提交表单' },
  { value: 'signup', label: '注册' },
  { value: 'trial', label: '开始试用' },
  { value: 'purchase', label: '购买' },
  { value: 'download', label: '下载' },
  { value: 'custom', label: '其他操作' },
] as const;
const TRACKING_DATASET_KINDS = new Set(['analytics_performance', 'sem_performance', 'business_outcome']);

async function rpc<T>(message: RuntimeMessage): Promise<T> {
  const response = await chrome.runtime.sendMessage(message) as RpcResponse<T>;
  if (!response?.ok) throw new Error(response?.error || '扩展请求失败。');
  return response.result as T;
}

function signalIcon(status: OverseasSignalStatus) {
  if (status === 'normal') return <Check size={18} />;
  if (status === 'attention') return <AlertCircle size={18} />;
  return <CircleHelp size={18} />;
}

function ResultGroup({ icon: Icon, title, status, conclusion, checked, impact, details }: {
  icon: typeof Globe2;
  title: string;
  status: OverseasSignalStatus;
  conclusion: string;
  checked: string;
  impact: string;
  details?: ReactNode;
}) {
  return <article className={`overseas-result-group status-${status}`}>
    <div className="overseas-result-group-heading"><span className="overseas-result-icon"><Icon size={19} /></span><div><h3>{title}</h3><span className="signal-state">{signalIcon(status)}{STATUS_LABELS[status]}</span></div></div>
    <dl><div><dt>当前结论</dt><dd>{conclusion}</dd></div><div><dt>插件检查了什么</dt><dd>{checked}</dd></div><div><dt>这对网站有什么影响</dt><dd>{impact}</dd></div></dl>
    {details ? <details className="overseas-group-details"><summary>查看检查明细</summary>{details}</details> : null}
  </article>;
}

interface OverseasWorkspaceProps {
  report: AuditReport | null;
  scanState: ScanState;
  onScan: () => Promise<void>;
  onGrantPageAccess: () => Promise<void>;
}

export function OverseasWorkspace({ report, scanState, onScan, onGrantPageAccess }: OverseasWorkspaceProps) {
  const [section, setSection] = useState<Section>('summary');
  const [selectedRecommendationId, setSelectedRecommendationId] = useState<string | null>(null);
  const [project, setProject] = useState<SearchProject | null>(null);
  const [datasets, setDatasets] = useState<ImportDataset[]>([]);
  const [staticSnapshot, setStaticSnapshot] = useState<OverseasStaticSnapshot | null>(report?.snapshot.overseas ?? null);
  const [trackingRuns, setTrackingRuns] = useState<TrackingTestRun[]>([]);
  const [reconciliation, setReconciliation] = useState<TrackingReconciliationReport | null>(null);
  const [goal, setGoal] = useState<TrackingTestRun['goal']>('lead');
  const [customEvent, setCustomEvent] = useState('');
  const [trackingToolsOpen, setTrackingToolsOpen] = useState(false);
  const [reconciliationOpen, setReconciliationOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const projectRef = useRef<SearchProject | null>(null);
  const issueScrollRef = useRef(0);
  const currentRun = trackingRuns.find((run) => run.status === 'running' && (!report || run.tabId === report.tabId)) ?? trackingRuns[0] ?? null;

  const refresh = useCallback(async () => {
    if (!report) {
      projectRef.current = null;
      setProject(null); setDatasets([]); setTrackingRuns([]); setReconciliation(null);
      return;
    }
    const currentProject = await createProjectForOrigin(new URL(report.url).origin);
    projectRef.current = currentProject;
    setProject(currentProject);
    const [nextDatasets, nextRuns, nextReport] = await Promise.all([
      listDatasets(currentProject.id), listTrackingRuns(currentProject.id), latestOverseasReport(currentProject.id),
    ]);
    setDatasets(nextDatasets);
    setTrackingRuns(nextRuns);
    setReconciliation(nextReport ?? null);
  }, [report?.url]);

  useEffect(() => { void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : '无法准备当前网站的海外检查。')); }, [refresh]);
  useEffect(() => { setStaticSnapshot(report?.snapshot.overseas ?? null); }, [report?.id, report?.snapshot.overseas?.internationalSeo.relatedCheck?.checkedAt]);
  useEffect(() => {
    if (currentRun?.status === 'running') setTrackingToolsOpen(true);
  }, [currentRun?.id, currentRun?.status]);
  useEffect(() => {
    if (reconciliation || datasets.some((item) => TRACKING_DATASET_KINDS.has(item.kind))) setReconciliationOpen(true);
  }, [datasets, reconciliation]);
  useEffect(() => {
    const listener = (message: RuntimeMessage) => {
      if (message.type === 'TRACKING_TEST_CHANGED' && message.projectId === project?.id) {
        setTrackingRuns((current) => [message.run, ...current.filter((run) => run.id !== message.run.id)]);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [project?.id]);
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('.app-main')?.scrollTo({
        top: section === 'issues' ? issueScrollRef.current : 0,
        behavior: 'auto',
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [section]);

  const updateProject = async (patch: Partial<SearchProject>) => {
    const current = projectRef.current;
    if (!current) return;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    projectRef.current = next;
    setProject(next);
    try { await saveProject(next); }
    catch (reason) { setError(reason instanceof Error ? `设置保存失败：${reason.message}` : '设置保存失败，请重试。'); }
  };
  const updateInternational = async (patch: Partial<NonNullable<SearchProject['international']>>) => {
    const current = projectRef.current;
    if (!current) return;
    await updateProject({ international: { targetCountry: '', targetLanguage: '', searchEngine: 'both', useGoogleAds: false, useMicrosoftAds: false, conversionDomains: [], ...current.international, ...patch } });
  };
  const grantRelatedAccess = async () => {
    if (!report || !project?.international) return;
    const origins = staticSnapshot?.internationalSeo.relatedCheck?.skippedOrigins ?? [];
    if (!origins.length) return;
    setBusy(true); setError('');
    try {
      const patterns = origins.map(originPermissionPattern);
      if (!(await chrome.permissions.request({ origins: patterns }))) {
        setNotice('没有授权跨域地址，当前报告仍保留已取得的检查结果。');
        return;
      }
      const next = await rpc<OverseasStaticSnapshot>({ type: 'CHECK_HREFLANG_TARGETS', report, settings: project.international });
      setStaticSnapshot(next);
      setNotice(`已补充检查 ${next.internationalSeo.relatedCheck?.checkedUrls.length ?? 0} 个关联版本`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '跨域关联版本检查失败。'); }
    finally { setBusy(false); }
  };
  const startTracking = async () => {
    if (!project || !report) return;
    setBusy(true); setError('');
    try {
      const extraOrigins = (project.international?.conversionDomains ?? []).flatMap((value) => {
        try { return [originPermissionPattern(/^https?:\/\//i.test(value) ? value : `https://${value}`)]; } catch { return []; }
      });
      if (extraOrigins.length && !(await chrome.permissions.contains({ origins: extraOrigins }))) {
        if (!(await chrome.permissions.request({ origins: extraOrigins }))) throw new Error('未授权跨域转化页面；请移除该域名或允许读取后再开始跨域测试。');
      }
      const run = await rpc<TrackingTestRun>({ type: 'START_TRACKING_TEST', projectId: project.id, tabId: report.tabId, goal, ...(goal === 'custom' && customEvent.trim() ? { customEvent: customEvent.trim() } : {}) });
      setTrackingRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      setNotice('追踪测试已开始，请在网页完成一次成功操作和一次失败操作');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法开始测试。'); }
    finally { setBusy(false); }
  };
  const markOutcome = async (outcome: 'success' | 'failure') => {
    if (!project || !report) return;
    setBusy(true); setError('');
    try {
      let run = await rpc<TrackingTestRun>({ type: 'MARK_TRACKING_ACTION', projectId: project.id, tabId: report.tabId, outcome });
      if (run.successfulActionObserved && run.failedActionObserved && run.status === 'running') {
        run = await rpc<TrackingTestRun>({ type: 'STOP_TRACKING_TEST', projectId: project.id, tabId: report.tabId });
        setNotice('成功和失败操作都已完成，测试已自动停止');
      }
      setTrackingRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法记录操作结果。'); }
    finally { setBusy(false); }
  };
  const stopTracking = async () => {
    if (!project || !report) return;
    setBusy(true);
    try {
      const run = await rpc<TrackingTestRun>({ type: 'STOP_TRACKING_TEST', projectId: project.id, tabId: report.tabId });
      setTrackingRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      setNotice('追踪测试已停止并保存脱敏摘要');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法停止测试。'); }
    finally { setBusy(false); }
  };
  const runReconciliation = async () => {
    if (!project) return;
    setBusy(true); setError('');
    try {
      const result = await rpc<TrackingReconciliationReport>({ type: 'RUN_TRACKING_RECONCILIATION', projectId: project.id });
      setReconciliation(result); setNotice('三方数据核对完成');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '数据核对失败。'); }
    finally { setBusy(false); }
  };
  const clearOverseas = async () => {
    if (!project || !window.confirm('删除当前网站的 GA4 数据、追踪测试历史和海外核对报告？')) return;
    await clearOverseasProjectData(project.id); await refresh(); setNotice('当前网站海外数据已清除');
  };
  const changeSection = (next: Section) => {
    if (section === 'issues') {
      issueScrollRef.current = document.querySelector<HTMLElement>('.app-main')?.scrollTop ?? 0;
    }
    setSection(next);
  };
  const openRecommendation = (finding: OverseasDiagnosticFinding) => {
    issueScrollRef.current = document.querySelector<HTMLElement>('.app-main')?.scrollTop ?? 0;
    setSelectedRecommendationId(finding.id);
    setSection('recommendations');
  };
  const onSectionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: Section) => {
    const index = SECTIONS.findIndex(([id]) => id === current);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % SECTIONS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + SECTIONS.length) % SECTIONS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = SECTIONS.length - 1;
    else return;
    event.preventDefault(); changeSection(SECTIONS[next]![0]);
    requestAnimationFrame(() => document.getElementById(`overseas-tab-${SECTIONS[next]![0]}`)?.focus());
  };

  const summary = useMemo<OverseasSummary | null>(() => report && project?.international ? buildOverseasSummary({
    snapshot: report.snapshot, staticSnapshot, settings: project.international, trackingRun: currentRun,
    expectedIndexState: report.context.expectedIndexState,
    ...(project.international.googleVerification ? { googleVerification: project.international.googleVerification } : {}),
    reconciliation,
  }) : null, [currentRun, project?.international, reconciliation, report, staticSnapshot]);
  const recommendations = useMemo(() => report && summary ? buildOverseasOptimizationRecommendations(report, summary) : [], [report, summary]);
  const trackingDatasets = datasets.filter((item) => TRACKING_DATASET_KINDS.has(item.kind));
  const trackingIssues = summary?.issues.filter((item) => item.category === 'tracking') ?? [];
  const internationalIssues = summary?.issues.filter((item) => item.category === 'international') ?? [];
  const searchIssues = summary?.issues.filter((item) => item.category === 'search_access') ?? [];
  const hasAnalyticsTag = staticSnapshot?.tags.some((tag) => ['google_analytics', 'google_tag_manager', 'microsoft_clarity'].includes(tag.platform) && (tag.ids.length || tag.scriptCount || tag.initialized || tag.requestObserved)) ?? false;
  const hasAdEvidence = staticSnapshot?.tags.some((tag) => ['google_ads', 'bing_uet'].includes(tag.platform) && (tag.ids.length || tag.scriptCount || tag.initialized || tag.requestObserved)) ?? false;

  return <div className="overseas-workspace view-stack">
    <header className="overseas-page-header">
      <div><p className="section-kicker">当前网站自动报告</p><h2>海外站优化</h2><p>检查国际搜索、分析统计和广告追踪；高级工具只在“追踪”中按需运行。</p></div>
      {report ? <div className="current-site-badge" aria-label={`当前检查网站 ${new URL(report.url).hostname}`}><Globe2 size={17} /><span><small>当前网站</small>{new URL(report.url).hostname}</span><Check size={16} /></div> : null}
    </header>
    <div className="overseas-segments" role="tablist" aria-label="海外站优化工作区">{SECTIONS.map(([id, label, Icon]) => <button key={id} id={`overseas-tab-${id}`} type="button" role="tab" aria-selected={section === id} aria-controls={`overseas-panel-${id}`} tabIndex={section === id ? 0 : -1} className={section === id ? 'active' : ''} onClick={() => changeSection(id)} onKeyDown={(event) => onSectionKeyDown(event, id)}><Icon size={16} />{label}</button>)}</div>
    {error ? <div className="inline-alert" role="alert"><AlertCircle size={17} />{error}</div> : null}
    {notice ? <div className="notice success-notice" role="status"><Check size={17} />{notice}</div> : null}
    {!report ? <section className="sem-empty overseas-auto-empty"><Globe2 size={30} /><h3>{scanState.status === 'permission_required' ? '需要授权当前网站' : scanState.status === 'unsupported' ? '当前页面无法检查' : scanState.status === 'error' ? '自动检查没有完成' : '正在准备当前网站检查'}</h3><p>{scanState.status === 'permission_required' ? scanState.reason : scanState.status === 'unsupported' ? scanState.reason : scanState.status === 'error' ? scanState.message : '进入海外站优化后会自动扫描当前网页，不需要输入网站地址或创建项目。'}</p>{scanState.status === 'permission_required' ? <button type="button" className="primary-button" onClick={() => void onGrantPageAccess()}><ShieldCheck size={17} />授权并自动检查</button> : scanState.status === 'error' || scanState.status === 'idle' ? <button type="button" className="primary-button" onClick={() => void onScan()}><RotateCw size={17} />重新检查当前网页</button> : null}</section> : null}
    {report && !project ? <section className="sem-empty overseas-auto-empty" role="status"><Activity className="spinner" size={30} /><h3>正在整理检查结果</h3><p>正在把当前网站的国际 SEO、追踪信号和建议放在一起。</p></section> : null}

    {project && summary && section === 'summary' ? <div id="overseas-panel-summary" role="tabpanel" aria-labelledby="overseas-tab-summary" className="overseas-panel overseas-summary-panel">
      <section className="overseas-summary-status" aria-label="海外站检查摘要">
        <div><span className="summary-scan-state"><Check size={16} />自动检查完成</span><p>{new URL(report!.url).pathname || '/'} · {new Date(staticSnapshot?.checkedAt ?? report!.createdAt).toLocaleString('zh-CN')}</p></div>
        <div className="overseas-counts"><span className="count-good">正常 <span className="count-value">{summary.normalCount}</span></span><span className="count-attention">问题 <span className="count-value">{summary.issueCount}</span></span><span className="count-confirm">优化机会 <span className="count-value">{summary.opportunityCount}</span></span></div>
      </section>

      <div className="overseas-result-groups">
        <ResultGroup icon={Globe2} title="搜索访问" status={searchIssues.length ? 'attention' : summary.searchAccess.status} conclusion={searchIssues[0]?.title ?? (summary.searchAccess.status === 'normal' ? '当前页面可公开访问，标题和主要内容可以读取。' : summary.searchAccess.title)} checked="HTTPS、公开响应、robots、索引指令、Canonical、标题和主要正文。" impact="决定 Google 和 Bing 是否具备访问、读取和理解页面的基本条件；不等于已经收录或有排名。" details={<ul>{summary.normalItems.filter((item) => /HTTPS|公开访问|抓取规则|主要内容/.test(item.title)).map((item) => <li key={item.id}>{item.title}：{item.evidence}</li>)}</ul>} />
        <ResultGroup icon={Languages} title="语言与地区" status={internationalIssues.length ? 'attention' : 'normal'} conclusion={internationalIssues[0]?.title ?? `${staticSnapshot?.internationalSeo.htmlLang || '未声明语言'}；${staticSnapshot?.internationalSeo.hreflangCount ? `发现 ${staticSnapshot.internationalSeo.hreflangCount} 条多语言关系` : '当前为单语言页面，不要求 hreflang'}`} checked="html lang、正文语言候选、hreflang、Canonical、关联语言或移动版本及地区格式信号。" impact="帮助搜索引擎把正确语言和地区版本展示给对应用户；单语言网站无需为了工具结果创建语言页。" details={<div className="overseas-detail-stack"><p>正文语言候选：{staticSnapshot?.internationalSeo.detectedLanguage || '证据不足'} · {staticSnapshot?.internationalSeo.languageConfidence || 'low'}</p><p>关联版本：{staticSnapshot?.internationalSeo.relatedCheck?.status === 'complete' ? `已自动检查 ${staticSnapshot.internationalSeo.relatedCheck.checkedUrls.length} 个` : staticSnapshot?.internationalSeo.relatedCheck?.status === 'partial' ? '已检查可访问地址，部分跨域地址未授权' : '当前没有需要检查的关联版本'}</p>{staticSnapshot?.internationalSeo.targets?.map((target) => <p key={`${target.kind}-${target.url}`}>{target.lang}：{target.issue || `状态 ${target.status}，语言 ${target.htmlLang}`}</p>)}</div>} />
        <ResultGroup icon={BarChart3} title="数据统计" status={trackingIssues.length ? 'attention' : hasAnalyticsTag ? 'normal' : 'confirm'} conclusion={trackingIssues[0]?.title ?? (hasAnalyticsTag ? '发现统计标签或运行证据；平台是否收到仍需后台数据证明。' : '当前未发现 GA4、GTM 或 Clarity 运行证据。')} checked="GA4、GTM、百度统计、Clarity 的标签 ID、初始化、浏览器请求和 Consent 现场。" impact="用于判断海外访问和关键事件是否有可核对的数据；安装标签本身不会提高 SEO 排名。" details={<ul>{staticSnapshot?.tags.map((tag) => <li key={tag.platform}>{PLATFORM_LABELS[tag.platform]}：{tag.requestObserved ? '观察到请求' : tag.initialized ? '观察到初始化' : tag.scriptCount || tag.ids.length ? '发现标签' : '未发现'}</li>)}{summary.otherAnalytics.map((item) => <li key={item.platform}>{item.label}：{item.requestObserved ? '观察到请求' : '发现脚本'}</li>)}</ul>} />
        <ResultGroup icon={Radio} title="广告与业务" status={trackingIssues.length ? 'attention' : hasAdEvidence ? 'confirm' : 'untested'} conclusion={trackingIssues[0]?.title ?? (hasAdEvidence ? '发现广告追踪证据，但平台转化和真实业务仍需核对。' : '当前没有发现需要检查的 Google Ads 或 Microsoft Ads 投放证据。')} checked="Google Ads、Bing UET、点击参数保留，以及当前能确认到的页面、请求、平台和业务证据层级。" impact="防止咨询、注册或购买被漏记、重复记录或错误归因，避免广告数据误导投放判断。" details={<p>{summary.googleAds.explanation}</p>} />
      </div>

      <details className="plain-section overseas-normal-details"><summary>查看已确认正常项目（{summary.normalCount}）</summary><ul className="overseas-result-list status-normal">{summary.normalItems.map((item) => <li key={item.id}><Check size={17} /><span><span className="result-title">{item.title}</span><span className="result-evidence">{item.evidence}</span></span></li>)}</ul></details>
      <details className="plain-section overseas-evidence-boundaries"><summary>查看检测边界（{summary.evidenceGaps.length}）</summary><div className="boundary-list">{summary.evidenceGaps.map((gap) => <article key={gap.id}><h3>{gap.title}</h3><p><span>已确认</span>{gap.confirmed}</p><p><span>无法直接确认</span>{gap.unavailable}</p><p><span>判断限制</span>{gap.limitation}</p>{gap.id === 'overseas:boundary:related-origin-permission' ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void grantRelatedAccess()}><ShieldCheck size={16} />授权并补充跨域检查</button> : null}</article>)}</div></details>
      <details className="plain-section project-settings optional-settings"><summary>补充网站业务信息（可选）</summary><div className="optional-settings-content"><p className="heading-help">不填写也能完成自动检查；填写后只重新生成依赖目标市场的结论，不需要刷新页面证据。</p><div className="project-form-grid"><label><span>目标国家或地区</span><input value={project.international?.targetCountry ?? ''} placeholder="例如：美国" onChange={(event) => void updateInternational({ targetCountry: event.target.value })} /></label><label><span>目标语言</span><input value={project.international?.targetLanguage ?? ''} placeholder="例如：en-US" onChange={(event) => void updateInternational({ targetLanguage: event.target.value })} /></label><SelectField label="主要搜索引擎" value={project.international?.searchEngine ?? 'both'} onChange={(value) => void updateInternational({ searchEngine: value as NonNullable<SearchProject['international']>['searchEngine'] })} options={[{ value: 'both', label: 'Google 与 Bing' }, { value: 'google', label: 'Google' }, { value: 'bing', label: 'Bing' }]} /></div></div></details>
    </div> : null}

    {project && summary && section === 'issues' ? <div id="overseas-panel-issues" role="tabpanel" aria-labelledby="overseas-tab-issues" className="overseas-panel overseas-issues-panel">
      <section className="overseas-section-intro"><div><p className="section-kicker">直接证据</p><h2>海外站问题</h2><p>这里只列出已经取得直接异常证据的问题。优化机会、未运行测试和平台后台未知结果不会混入问题数量。</p></div><span className="section-count">{summary.issueCount}</span></section>
      {summary.issues.length ? <div className="overseas-problem-list">{summary.issues.map((finding) => <article className={`overseas-problem-card priority-${finding.priority.toLocaleLowerCase()}`} key={finding.id} data-overseas-problem-id={finding.id}><div className="overseas-problem-heading"><span className={`priority-badge priority-${finding.priority.toLocaleLowerCase()}`}>{finding.priority}</span><div><h3>{finding.title}</h3><p>{finding.category === 'search_access' ? '搜索访问' : finding.category === 'international' ? '语言与地区' : '数据追踪'}</p></div></div><dl><div><dt>直接证据</dt><dd>{finding.evidence}</dd></div><div><dt>影响范围</dt><dd>当前页面及使用相同模板或追踪配置的页面</dd></div><div><dt>为什么重要</dt><dd>{finding.why}</dd></div><div><dt>检测限制</dt><dd>{finding.limitation}</dd></div></dl><button type="button" className="primary-button" onClick={() => openRecommendation(finding)}>查看优化建议</button></article>)}</div> : <section className="overseas-zero-panel" role="status"><Check size={28} /><h3>本次未取得直接异常证据</h3><p>这不代表网站没有增长空间。条件性改进和更完整的数据能力会放在“优化建议”中，并明确适用前提。</p><button type="button" className="secondary-button" onClick={() => changeSection('recommendations')}><Lightbulb size={16} />查看优化建议</button></section>}
      <details className="plain-section overseas-evidence-boundaries"><summary>查看不会被当成问题的检测边界</summary><div className="boundary-list">{summary.evidenceGaps.map((gap) => <article key={gap.id}><h3>{gap.title}</h3><p>{gap.limitation}</p></article>)}</div></details>
    </div> : null}

    {project && summary && report && section === 'recommendations' ? <div id="overseas-panel-recommendations" role="tabpanel" aria-labelledby="overseas-tab-recommendations" className="overseas-panel overseas-recommendations-panel recommendations-view">
      <section className="overseas-section-intro"><div><p className="section-kicker">策略、代码与验证</p><h2>海外优化方案</h2><p>已确认问题对应的方案排在前面，条件性机会随后展示。每项都说明适用前提、修改位置、代码含义、直接结果和效果边界。</p></div><span className="section-count">{recommendations.length}</span></section>
      <RecommendationSolutions recommendations={recommendations} selectedRecommendationId={selectedRecommendationId} emptyMessage="当前页面没有生成海外优化建议；平台接收、真实收录和业务结果仍需对应外部数据确认。" />
    </div> : null}

    {project && summary && section === 'tracking' ? <div id="overseas-panel-tracking" role="tabpanel" aria-labelledby="overseas-tab-tracking" className="overseas-panel overseas-tracking-panel">
      <section className="overseas-section-intro tracking-intro"><div><p className="section-kicker">分析与广告数据</p><h2>追踪</h2><p>判断客户咨询、注册或购买有没有漏记、重复记录或错误归因。页面标签自动检查，现场监听和 CSV 导入只在你主动使用时运行。</p></div>{currentRun?.status === 'running' ? <span className="rec-badge"><i />REC</span> : null}</section>
      <section className="plain-section tracking-auto-results"><div className="section-heading"><div><p className="section-kicker">自动检查</p><h2>当前页面的标签和请求</h2></div></div><div className="tracking-layer-list"><div><span>1</span><p>页面存在标签<small>{staticSnapshot?.tags.some((tag) => tag.scriptCount || tag.ids.length) ? '已观察到标签或 ID' : '未观察到'}</small></p></div><div><span>2</span><p>浏览器观察到初始化<small>{staticSnapshot?.tags.some((tag) => tag.initialized) ? '已观察到' : '未观察到'}</small></p></div><div><span>3</span><p>浏览器观察到请求<small>{staticSnapshot?.tags.some((tag) => tag.requestObserved) ? '已观察到' : '未观察到'}</small></p></div><div><span>4</span><p>平台后台确认收到<small>浏览器无法直接确认</small></p></div><div><span>5</span><p>后端确认有效业务<small>{reconciliation ? '已有导入报表核对结果' : '需要业务结果数据'}</small></p></div></div><details className="tracking-technical-details"><summary>查看标签与 Consent 技术详情</summary>{staticSnapshot ? <div className="tag-snapshot"><div className="tag-table" role="table" aria-label="分析与广告标签状态">{staticSnapshot.tags.map((tag) => <div role="row" key={tag.platform}><span role="cell">{PLATFORM_LABELS[tag.platform]}</span><span role="cell">{tag.ids.join('、') || '未识别 ID'}</span><span role="cell">{tag.initialized ? '已初始化' : tag.scriptCount ? '有脚本，未确认初始化' : '未发现'}</span><span role="cell">{tag.requestObserved ? '观察到请求' : '未观察到请求'}</span></div>)}</div><p>{staticSnapshot.consent.explanation}</p></div> : <p>当前没有可用页面标签快照。</p>}</details></section>

      <details className="plain-section tracking-tool-section" open={trackingToolsOpen} onToggle={(event) => setTrackingToolsOpen(event.currentTarget.open)}><summary><span><Radio size={18} /><span>现场追踪测试<small>实际操作一次，检查成功漏记、重复记录和失败误计</small></span></span><ChevronDown size={18} /></summary><div className="tracking-tool-content"><div className="tracking-status-flow"><ol><li className={currentRun ? 'current-or-done' : ''}><span>1</span><div><p>开始临时观察</p><small>{currentRun?.status === 'running' ? '正在观察当前网页' : currentRun ? '已有最近一次测试结果' : '尚未开始，不计入网站问题'}</small></div></li><li className={currentRun?.successfulActionObserved ? 'current-or-done' : ''}><span>2</span><div><p>完成一次成功操作</p><small>{currentRun?.successfulActionObserved ? '已标记，正在核对事件' : '例如成功提交咨询或完成购买'}</small></div></li><li className={currentRun?.failedActionObserved ? 'current-or-done' : ''}><span>3</span><div><p>完成一次失败操作</p><small>{currentRun?.failedActionObserved ? '已标记，正在核对是否误计' : '例如提交缺少必填项的表单'}</small></div></li><li className={currentRun && currentRun.status !== 'running' ? 'current-or-done' : ''}><span>4</span><div><p>查看测试结论</p><small>成功应只记一次，失败不应算转化</small></div></li></ol></div><div className="tracking-controls"><SelectField label="本次测试目标" value={goal} onChange={(value) => setGoal(value as TrackingTestRun['goal'])} options={[...GOAL_OPTIONS]} />{goal === 'custom' ? <label><span>自定义事件名</span><input value={customEvent} onChange={(event) => setCustomEvent(event.target.value)} placeholder="例如：book_demo" /></label> : null}<div className="button-row">{currentRun?.status === 'running' ? <button type="button" className="stop-button" disabled={busy} onClick={() => void stopTracking()}><Square size={17} />停止测试</button> : <button type="button" className="primary-button" disabled={!report || busy || (goal === 'custom' && !customEvent.trim())} onClick={() => void startTracking()}><Play size={17} />开始测试</button>}</div></div>{currentRun?.status === 'running' ? <div className="outcome-confirm"><p>回到网页完成操作后，在这里确认：</p><button type="button" className={currentRun.successfulActionObserved ? 'complete' : ''} disabled={busy || currentRun.successfulActionObserved} onClick={() => void markOutcome('success')}><Check size={16} />成功操作已完成</button><button type="button" className={currentRun.failedActionObserved ? 'complete' : ''} disabled={busy || currentRun.failedActionObserved} onClick={() => void markOutcome('failure')}><AlertCircle size={16} />失败操作已完成</button></div> : null}{currentRun ? <div className={`tracking-plain-conclusion status-${summary.tracking.status}`} role="status"><h3>本次测试结论</h3>{summary.tracking.messages.map((message) => <p key={message}>{summary.tracking.status === 'normal' ? <Check size={16} /> : <AlertCircle size={16} />}<span>{message}</span></p>)}</div> : null}{currentRun ? <details className="tracking-timeline-details"><summary>查看事件时间线与技术证据</summary><div className="tracking-timeline" aria-label="追踪事件时间线">{currentRun.observations.length ? currentRun.observations.map((item) => <div className="tracking-event" key={item.id}><span>{Math.round(item.relativeMs / 100) / 10}s</span><div><p>{item.name}</p><small>{item.platform} · {item.type}{item.fields.sensitiveField ? ' · 疑似敏感字段' : ''}</small></div></div>) : <p className="empty-copy">尚未观察到事件。测试运行时请在原网页完成目标操作。</p>}</div></details> : null}{trackingRuns.length ? <div className="tracking-history"><h3>最近追踪测试</h3>{trackingRuns.slice(0, 20).map((run) => <div key={run.id}><span>{new Date(run.startedAt).toLocaleString('zh-CN')} · {run.status} · {run.observations.length} 条</span><button type="button" className="icon-button" aria-label="删除这次追踪测试" onClick={() => void deleteTrackingRun(run.id).then(() => refresh())}><Trash2 size={16} /></button></div>)}</div> : null}</div></details>

      <details className="plain-section tracking-tool-section" open={reconciliationOpen} onToggle={(event) => setReconciliationOpen(event.currentTarget.open)}><summary><span><FileSpreadsheet size={18} /><span>报表数据核对<small>把 GA4、广告平台和真实业务结果放到同一口径比较</small></span></span><ChevronDown size={18} /></summary><div className="tracking-tool-content"><div className="data-source-explanation"><p><span>GA4</span>说明网站记录了多少会话和关键事件。</p><p><span>广告报表</span>说明平台记录了多少点击、费用和转化。</p><p><span>业务结果</span>说明最终有多少有效线索、订单、退款和收入。</p></div><p className="section-note">原始 CSV 不保存，邮箱、电话、姓名和地址列禁止映射。</p><label className="wide-field reconciliation-currency"><span>数据比较币种</span><small>三份报表币种不一致时只比较数量，不比较金额。</small><input aria-label="数据比较币种" value={project.currency} maxLength={3} onChange={(event) => void updateProject({ currency: event.target.value.toUpperCase().replace(/[^A-Z]/g, '') })} /></label><div className="overseas-data-sources"><CsvImporter kind="analytics_performance" project={project} onImported={(dataset) => setDatasets((current) => [dataset, ...current.filter((item) => item.id !== dataset.id)])} /><CsvImporter kind="sem_performance" project={project} onImported={(dataset) => setDatasets((current) => [dataset, ...current.filter((item) => item.id !== dataset.id)])} /><CsvImporter kind="business_outcome" project={project} onImported={(dataset) => setDatasets((current) => [dataset, ...current.filter((item) => item.id !== dataset.id)])} /></div>{trackingDatasets.length ? <div className="dataset-list">{trackingDatasets.map((dataset) => <div className="dataset-row" key={dataset.id}><div><span>{dataset.name}</span><p>{dataset.kind} · {dataset.rowCount.toLocaleString()} 行</p></div><button type="button" className="icon-button" aria-label={`删除 ${dataset.name}`} onClick={() => void deleteDataset(dataset).then(() => refresh())}><Trash2 size={16} /></button></div>)}</div> : null}<button type="button" className="primary-button reconciliation-run" disabled={busy} onClick={() => void runReconciliation()}>{busy ? <Activity className="spinner" size={17} /> : <ShieldCheck size={17} />}运行三方数据核对</button>{reconciliation ? <div className="reconciliation-results"><div className="reconciliation-funnel" aria-label="追踪数据漏斗">{[['广告点击', reconciliation.clicks], ['分析会话', reconciliation.sessions], ['分析关键事件', reconciliation.analyticsKeyEvents], ['平台转化', reconciliation.platformConversions], ['有效业务', reconciliation.validConversions]].map(([label, value]) => <div key={String(label)}><span>{label}</span><p>{Number(value).toLocaleString()}</p></div>)}</div><div className="reconciliation-basis" aria-label="三方核对口径"><p><span>可比较周期</span>{reconciliation.period?.start && reconciliation.period?.end ? `${reconciliation.period.start} 至 ${reconciliation.period.end}` : '没有成熟的重叠周期'}</p><p><span>网站时区 / 成熟期</span>{reconciliation.period?.timezone || project.timezone} / {reconciliation.period?.maturityDays ?? 1} 天</p><p><span>路径对齐</span>{reconciliation.alignment?.matchedLandingPages ?? 0} 个落地页在广告与 GA4 中匹配</p><p><span>业务归因</span>点击 ID {reconciliation.alignment?.highConfidenceRows ?? 0} · 唯一 UTM {reconciliation.alignment?.mediumConfidenceRows ?? 0} · 系列+日期 {reconciliation.alignment?.lowConfidenceRows ?? 0}</p><p><span>货币口径</span>{reconciliation.currencyComparable === false ? `不可比较：${reconciliation.observedCurrencies?.join('、') || '币种冲突'}` : `${reconciliation.currency || project.currency}，可按当前口径展示`}</p></div>{reconciliation.findings.length ? <p className="reconciliation-finding-note">核对发现 {reconciliation.findings.length} 个问题，已经同步进入“问题”和“优化建议”。</p> : <p className="reconciliation-finding-note">本次核对没有取得直接异常证据。</p>}{reconciliation.gaps.length ? <div className="data-gap-list"><h3>仍缺少的数据与口径说明</h3>{reconciliation.gaps.map((gap) => <p key={gap}>{gap}</p>)}</div> : null}</div> : null}</div></details>

      <details className="plain-section tracking-settings"><summary>追踪与广告设置（可选）</summary><div className="optional-settings-content"><label><span>核心转化</span><input value={project.primaryConversion} placeholder="例如：有效询盘" onChange={(event) => void updateProject({ primaryConversion: event.target.value })} /></label><div className="toggle-row"><label><input type="checkbox" checked={project.international?.useGoogleAds ?? false} onChange={(event) => void updateInternational({ useGoogleAds: event.target.checked })} />正在投放 Google Ads</label><label><input type="checkbox" checked={project.international?.useMicrosoftAds ?? false} onChange={(event) => void updateInternational({ useMicrosoftAds: event.target.checked })} />正在投放 Microsoft Ads</label></div><label className="wide-field"><span>跨域转化域名</span><small>例如 checkout.example.com。开始跨域测试时才会申请对应权限。</small><input value={(project.international?.conversionDomains ?? []).join(', ')} onChange={(event) => void updateInternational({ conversionDomains: event.target.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean) })} /></label></div></details>
      <button type="button" className="text-button destructive-action" onClick={() => void clearOverseas()}><Trash2 size={16} />清除当前网站海外数据</button>
    </div> : null}
  </div>;
}
