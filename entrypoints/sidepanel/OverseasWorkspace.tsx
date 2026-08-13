import {
  Activity,
  AlertCircle,
  BarChart3,
  Check,
  CircleHelp,
  FileSpreadsheet,
  Globe2,
  Languages,
  Play,
  Radio,
  RotateCw,
  ShieldCheck,
  Square,
  Trash2,
} from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useState } from 'react';

import type { AuditReport, RuntimeMessage, ScanState } from '../../src/lib/audit/types';
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
  InternationalSeoSnapshot,
  OverseasSignalStatus,
  OverseasStaticSnapshot,
  SearchProject,
  TrackingReconciliationReport,
  TrackingTestRun,
} from '../../src/lib/projects/types';
import { originPermissionPattern } from '../../src/lib/page-access';
import { diagnoseOverseasStatic } from '../../src/lib/overseas/diagnostics';
import { CsvImporter } from './CsvImporter';
import { SelectField } from './SelectField';

type Section = 'summary' | 'international' | 'tracking' | 'reconciliation';
interface RpcResponse<T> { ok: boolean; result?: T; error?: string }

const SECTIONS = [
  ['summary', '概况', Globe2],
  ['international', '国际 SEO', Languages],
  ['tracking', '追踪测试', Radio],
  ['reconciliation', '数据核对', BarChart3],
] as const;

const STATUS_LABELS: Record<OverseasSignalStatus, string> = {
  normal: '正常', attention: '需要处理', confirm: '需要确认', unavailable: '无法检测', untested: '尚未测试',
};
const PLATFORM_LABELS = {
  google_analytics: 'GA4', google_tag_manager: 'Google Tag Manager', google_ads: 'Google Ads', bing_uet: 'Bing UET', microsoft_clarity: 'Clarity',
} as const;
const GOAL_OPTIONS = [
  { value: 'lead', label: '咨询 / 有效线索' },
  { value: 'signup', label: '注册' },
  { value: 'trial', label: '开始试用' },
  { value: 'purchase', label: '购买' },
  { value: 'download', label: '下载' },
  { value: 'custom', label: '自定义事件' },
] as const;

async function rpc<T>(message: RuntimeMessage): Promise<T> {
  const response = await chrome.runtime.sendMessage(message) as RpcResponse<T>;
  if (!response?.ok) throw new Error(response?.error || '扩展请求失败。');
  return response.result as T;
}

function statusFromTags(
  snapshot: OverseasStaticSnapshot | null,
  platform: 'google' | 'bing',
  advertisingDeclared: boolean,
): OverseasSignalStatus {
  if (!snapshot) return 'untested';
  const targets = snapshot.tags.filter((tag) => platform === 'google' ? tag.platform.startsWith('google_') : tag.platform === 'bing_uet' || tag.platform === 'microsoft_clarity');
  if (targets.some((tag) => tag.requestObserved)) return 'normal';
  if (targets.some((tag) => tag.ids.length || tag.initialized || tag.scriptCount)) return 'confirm';
  return advertisingDeclared ? 'attention' : 'confirm';
}

function statusIcon(status: OverseasSignalStatus) {
  if (status === 'normal') return <Check size={17} />;
  if (status === 'attention') return <AlertCircle size={17} />;
  return <CircleHelp size={17} />;
}

interface OverseasWorkspaceProps {
  report: AuditReport | null;
  scanState: ScanState;
  onScan: () => Promise<void>;
  onGrantPageAccess: () => Promise<void>;
}

export function OverseasWorkspace({ report, scanState, onScan, onGrantPageAccess }: OverseasWorkspaceProps) {
  const [section, setSection] = useState<Section>('summary');
  const [project, setProject] = useState<SearchProject | null>(null);
  const [datasets, setDatasets] = useState<ImportDataset[]>([]);
  const [staticSnapshot, setStaticSnapshot] = useState<OverseasStaticSnapshot | null>(report?.snapshot.overseas ?? null);
  const [trackingRuns, setTrackingRuns] = useState<TrackingTestRun[]>([]);
  const [reconciliation, setReconciliation] = useState<TrackingReconciliationReport | null>(null);
  const [goal, setGoal] = useState<TrackingTestRun['goal']>('lead');
  const [customEvent, setCustomEvent] = useState('');
  const [checkingLanguages, setCheckingLanguages] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const currentRun = trackingRuns.find((run) => run.status === 'running' && (!report || run.tabId === report.tabId)) ?? trackingRuns[0] ?? null;

  const refresh = useCallback(async () => {
    if (!report) {
      setProject(null);
      setDatasets([]); setTrackingRuns([]); setReconciliation(null); return;
    }
    const currentProject = await createProjectForOrigin(new URL(report.url).origin);
    setProject(currentProject);
    const [nextDatasets, nextRuns, nextReport] = await Promise.all([
      listDatasets(currentProject.id),
      listTrackingRuns(currentProject.id),
      latestOverseasReport(currentProject.id),
    ]);
    setDatasets(nextDatasets);
    setTrackingRuns(nextRuns);
    setReconciliation(nextReport ?? null);
  }, [report?.url]);

  useEffect(() => {
    void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : '无法准备当前网站的海外检查。'));
  }, [refresh]);
  useEffect(() => { setStaticSnapshot(report?.snapshot.overseas ?? null); }, [report?.id]);
  useEffect(() => {
    const listener = (message: RuntimeMessage) => {
      if (message.type === 'TRACKING_TEST_CHANGED' && message.projectId === project?.id) {
        setTrackingRuns((current) => [message.run, ...current.filter((run) => run.id !== message.run.id)]);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [project?.id]);

  const updateProject = async (patch: Partial<SearchProject>) => {
    if (!project) return;
    const next = { ...project, ...patch, updatedAt: new Date().toISOString() };
    await saveProject(next);
    setProject(next);
  };
  const updateInternational = async (patch: Partial<NonNullable<SearchProject['international']>>) => {
    if (!project) return;
    await updateProject({ international: { targetCountry: '', targetLanguage: '', searchEngine: 'both', useGoogleAds: false, useMicrosoftAds: false, conversionDomains: [], ...project.international, ...patch } });
  };
  const refreshStatic = async () => {
    if (!report || !project?.international) throw new Error('请先打开并扫描当前项目的网站页面。');
    const next = await rpc<OverseasStaticSnapshot>({ type: 'GET_OVERSEAS_STATIC', report, settings: project.international });
    setStaticSnapshot(next);
    setNotice('海外站静态证据已更新');
  };
  const checkLanguages = async () => {
    if (!report || !project?.international) return;
    setCheckingLanguages(true); setError('');
    try {
      const origins = [...new Set(report.snapshot.hreflangs.flatMap((item) => {
        try { const origin = new URL(item.href, report.url).origin; return origin === new URL(report.url).origin ? [] : [originPermissionPattern(origin)]; } catch { return []; }
      }))];
      if (origins.length) {
        const already = await chrome.permissions.contains({ origins });
        if (!already && !(await chrome.permissions.request({ origins }))) throw new Error('未授权读取跨域语言页；当前页面检查仍可继续使用。');
      }
      const result = await rpc<{ targets: NonNullable<InternationalSeoSnapshot['targets']>; sitemapConsistency: NonNullable<InternationalSeoSnapshot['sitemapConsistency']> }>({ type: 'CHECK_HREFLANG_TARGETS', report, settings: project.international });
      setStaticSnapshot((current) => current ? { ...current, internationalSeo: { ...current.internationalSeo, targets: result.targets, sitemapConsistency: result.sitemapConsistency } } : current);
      setNotice(`已检查 ${result.targets.length} 个相关语言页`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '语言页检查失败。'); }
    finally { setCheckingLanguages(false); }
  };
  const startTracking = async () => {
    if (!project || !report) return;
    setBusy(true); setError('');
    try {
      const extraOrigins = (project.international?.conversionDomains ?? []).flatMap((value) => {
        try { return [originPermissionPattern(/^https?:\/\//i.test(value) ? value : `https://${value}`)]; } catch { return []; }
      });
      if (extraOrigins.length && !(await chrome.permissions.contains({ origins: extraOrigins }))) {
        const granted = await chrome.permissions.request({ origins: extraOrigins });
        if (!granted) throw new Error('未授权跨域转化页面；请移除该域名或允许读取后再开始跨域测试。');
      }
      const run = await rpc<TrackingTestRun>({ type: 'START_TRACKING_TEST', projectId: project.id, tabId: report.tabId, goal, ...(goal === 'custom' && customEvent.trim() ? { customEvent: customEvent.trim() } : {}) });
      setTrackingRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      setNotice('追踪测试已开始，请在网页完成一次成功操作和一次失败操作');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法开始测试。'); }
    finally { setBusy(false); }
  };
  const markOutcome = async (outcome: 'success' | 'failure') => {
    if (!project || !report) return;
    const run = await rpc<TrackingTestRun>({ type: 'MARK_TRACKING_ACTION', projectId: project.id, tabId: report.tabId, outcome });
    setTrackingRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
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
    try { const result = await rpc<TrackingReconciliationReport>({ type: 'RUN_TRACKING_RECONCILIATION', projectId: project.id }); setReconciliation(result); setNotice('三方数据核对完成'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '数据核对失败。'); }
    finally { setBusy(false); }
  };
  const clearOverseas = async () => {
    if (!project || !window.confirm('删除当前项目的 GA4 数据、追踪测试历史和海外核对报告？')) return;
    await clearOverseasProjectData(project.id); await refresh(); setNotice('当前网站海外数据已清除');
  };
  const onSectionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: Section) => {
    const index = SECTIONS.findIndex(([id]) => id === current);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % SECTIONS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + SECTIONS.length) % SECTIONS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = SECTIONS.length - 1;
    else return;
    event.preventDefault(); setSection(SECTIONS[next]![0]); requestAnimationFrame(() => document.getElementById(`overseas-tab-${SECTIONS[next]![0]}`)?.focus());
  };

  const statuses = useMemo(() => ({
    international: staticSnapshot?.internationalSeo.status ?? 'untested',
    google: statusFromTags(staticSnapshot, 'google', project?.international?.useGoogleAds ?? false),
    bing: statusFromTags(staticSnapshot, 'bing', project?.international?.useMicrosoftAds ?? false),
    data: reconciliation ? reconciliation.findings.some((item) => item.priority === 'P0' || item.priority === 'P1') ? 'attention' : reconciliation.gaps.length ? 'confirm' : 'normal' : 'untested',
  } satisfies Record<string, OverseasSignalStatus>), [reconciliation, staticSnapshot]);
  const staticFindings = useMemo(() => staticSnapshot && project?.international ? diagnoseOverseasStatic(staticSnapshot, project.international) : [], [project?.international, staticSnapshot]);
  const priorityActions = [
    ...(statuses.google === 'attention' && project?.international?.useGoogleAds ? ['正在投放 Google Ads，但页面未观察到 Google 追踪标签或请求，先检查安装与 Consent。'] : []),
    ...(statuses.bing === 'attention' && project?.international?.useMicrosoftAds ? ['正在投放 Microsoft Ads，但页面未观察到 UET，先检查标签是否覆盖落地页。'] : []),
    ...staticFindings.map((item) => item.action),
    ...((reconciliation?.findings ?? []).map((item) => item.action)),
    ...(statuses.google === 'confirm' && statuses.bing === 'confirm'
      ? ['如果网站依赖海外获客，请确认需要使用 GA4、Google Ads 或 Microsoft Ads；当前页面没有观察到可确认的收集请求。']
      : []),
  ].slice(0, 3);

  return <div className="overseas-workspace view-stack">
    <section className="overseas-hero">
      <div><p className="section-kicker">海外搜索增长</p><h2>海外站优化</h2><p>自动检查当前网站的国际页面配置、Google/Bing 追踪现场和广告到真实业务的数据链路。插件不会登录或修改任何平台账户。</p></div>
      {report ? <div className="current-site-badge" aria-label={`当前检查网站 ${new URL(report.url).hostname}`}><Globe2 size={17} /><span><small>当前网站</small>{new URL(report.url).hostname}</span><Check size={16} /></div> : null}
    </section>
    <div className="overseas-segments" role="tablist" aria-label="海外站优化工作区">{SECTIONS.map(([id, label, Icon]) => <button key={id} id={`overseas-tab-${id}`} type="button" role="tab" aria-selected={section === id} aria-controls={`overseas-panel-${id}`} tabIndex={section === id ? 0 : -1} className={section === id ? 'active' : ''} onClick={() => setSection(id)} onKeyDown={(event) => onSectionKeyDown(event, id)}><Icon size={16} />{label}</button>)}</div>
    {error ? <div className="inline-alert" role="alert"><AlertCircle size={17} />{error}</div> : null}
    {notice ? <div className="notice success-notice" role="status"><Check size={17} />{notice}</div> : null}
    {!report ? <section className="sem-empty overseas-auto-empty"><Globe2 size={30} /><h3>{scanState.status === 'permission_required' ? '需要授权当前网站' : scanState.status === 'unsupported' ? '当前页面无法检查' : scanState.status === 'error' ? '自动检查没有完成' : '正在准备当前网站检查'}</h3><p>{scanState.status === 'permission_required' ? scanState.reason : scanState.status === 'unsupported' ? scanState.reason : scanState.status === 'error' ? scanState.message : '进入海外站优化后会自动扫描当前网页，不需要输入网站地址或创建项目。'}</p>{scanState.status === 'permission_required' ? <button type="button" className="primary-button" onClick={() => void onGrantPageAccess()}><ShieldCheck size={17} />授权并自动检查</button> : scanState.status === 'error' || scanState.status === 'idle' ? <button type="button" className="primary-button" onClick={() => void onScan()}><RotateCw size={17} />重新检查当前网页</button> : null}</section> : null}
    {report && !project ? <section className="sem-empty overseas-auto-empty" role="status"><Activity className="spinner" size={30} /><h3>正在整理检查结果</h3><p>正在把当前网站的国际 SEO、追踪信号和建议放在一起。</p></section> : null}

    {project && section === 'summary' ? <div id="overseas-panel-summary" role="tabpanel" aria-labelledby="overseas-tab-summary" className="overseas-panel">
      <section className="overseas-status-grid" aria-label="海外站诊断状态">{([
        ['international', '国际 SEO'], ['google', 'Google 追踪链路'], ['bing', 'Bing 追踪链路'], ['data', '数据核对'],
      ] as const).map(([key, label]) => <button type="button" className={`overseas-status status-${statuses[key]}`} key={key} onClick={() => setSection(key === 'international' ? 'international' : key === 'data' ? 'reconciliation' : 'tracking')}><span>{statusIcon(statuses[key])}{label}</span><p>{STATUS_LABELS[statuses[key]]}</p></button>)}</section>
      <section className="plain-section overseas-priorities"><div className="section-heading"><div><p className="section-kicker">先做这三件事</p><h2>按证据缺口安排下一步</h2></div></div>{priorityActions.length ? <ol>{priorityActions.map((action) => <li key={action}>{action}</li>)}</ol> : <p className="empty-copy">当前没有高优先动作。继续完成一次现场追踪测试和数据核对，确认后台与真实业务。</p>}</section>
      <details className="plain-section project-settings optional-settings"><summary>补充业务目标（可选，可让建议更准确）</summary><div className="optional-settings-content"><div className="section-heading"><div><p className="section-kicker">可选信息</p><h2>告诉插件这个网站服务谁</h2><p className="heading-help">不填写也能完成自动检查；填写后可进一步判断地区、语言和广告追踪是否符合业务目标。</p></div></div>
        <div className="project-form-grid">
          <label><span>目标国家或地区</span><input value={project.international?.targetCountry ?? ''} placeholder="例如：美国" onChange={(event) => void updateInternational({ targetCountry: event.target.value })} /></label>
          <label><span>目标语言</span><input value={project.international?.targetLanguage ?? ''} placeholder="例如：en-US" onChange={(event) => void updateInternational({ targetLanguage: event.target.value })} /></label>
          <SelectField label="主要搜索引擎" value={project.international?.searchEngine ?? 'both'} onChange={(value) => void updateInternational({ searchEngine: value as NonNullable<SearchProject['international']>['searchEngine'] })} options={[{ value: 'both', label: 'Google 与 Bing' }, { value: 'google', label: 'Google' }, { value: 'bing', label: 'Bing' }]} />
          <label><span>核心转化</span><input value={project.primaryConversion} placeholder="例如：有效询盘" onChange={(event) => void updateProject({ primaryConversion: event.target.value })} /></label>
        </div>
        <div className="toggle-row"><label><input type="checkbox" checked={project.international?.useGoogleAds ?? false} onChange={(event) => void updateInternational({ useGoogleAds: event.target.checked })} />正在投放 Google Ads</label><label><input type="checkbox" checked={project.international?.useMicrosoftAds ?? false} onChange={(event) => void updateInternational({ useMicrosoftAds: event.target.checked })} />正在投放 Microsoft Ads</label></div>
        <label className="wide-field"><span>可选跨域转化域名</span><small>逗号分隔，例如 checkout.example.com。跨域继续测试前仍会单独请求权限。</small><input value={(project.international?.conversionDomains ?? []).join(', ')} onChange={(event) => void updateInternational({ conversionDomains: event.target.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean) })} /></label>
      </div></details>
    </div> : null}

    {project && section === 'international' ? <div id="overseas-panel-international" role="tabpanel" aria-labelledby="overseas-tab-international" className="overseas-panel">
      <section className="plain-section"><div className="section-heading"><div><p className="section-kicker">国际化页面</p><h2>语言页能否互相说明关系</h2><p className="heading-help">检查页面语言、目标语言和 hreflang。它不能模拟海外 IP，也不能证明当地排名。</p></div><Languages size={19} /></div>
        {!staticSnapshot ? <p className="empty-copy">先扫描当前页面，才能检查页面语言和 hreflang。</p> : <div className="international-summary"><p className={`signal-line status-${staticSnapshot.internationalSeo.status}`}>{statusIcon(staticSnapshot.internationalSeo.status)}{STATUS_LABELS[staticSnapshot.internationalSeo.status]}</p><dl><div><dt>页面声明语言</dt><dd>{staticSnapshot.internationalSeo.htmlLang || '未声明'}</dd></div><div><dt>正文语言候选</dt><dd>{staticSnapshot.internationalSeo.detectedLanguage || '证据不足'} · {staticSnapshot.internationalSeo.languageConfidence}</dd></div><div><dt>hreflang</dt><dd>{staticSnapshot.internationalSeo.hreflangCount} 条</dd></div><div><dt>x-default</dt><dd>{staticSnapshot.internationalSeo.xDefault ? '已设置' : '未设置或不适用'}</dd></div><div><dt>Googlebot</dt><dd>{report?.snapshot.siteProbe.robots.agentAccess?.Googlebot === false ? 'robots 禁止' : report?.snapshot.siteProbe.robots.agentAccess ? '允许访问' : '无法检测'}</dd></div><div><dt>Bingbot</dt><dd>{report?.snapshot.siteProbe.robots.agentAccess?.Bingbot === false ? 'robots 禁止' : report?.snapshot.siteProbe.robots.agentAccess ? '允许访问' : '无法检测'}</dd></div><div><dt>Sitemap 一致性</dt><dd>{staticSnapshot.internationalSeo.sitemapConsistency === 'matched' ? '已检查地址均出现' : staticSnapshot.internationalSeo.sitemapConsistency === 'partial' ? '部分语言页未出现' : '尚未核对'}</dd></div><div><dt>地区格式候选</dt><dd>{[...(staticSnapshot.internationalSeo.regionalSignals?.currencyCodes ?? []), ...(staticSnapshot.internationalSeo.regionalSignals?.phoneCountryCodes ?? [])].join('、') || '未识别'}</dd></div></dl>{staticSnapshot.internationalSeo.issues.map((issue) => <p className="finding-line" key={issue}>{issue}</p>)}</div>}
        <div className="button-row"><button type="button" className="secondary-button" disabled={!report || busy} onClick={() => void refreshStatic().catch((reason) => setError(reason instanceof Error ? reason.message : '检查失败'))}><RotateCw size={17} />刷新页面证据</button><button type="button" className="primary-button" disabled={!report || checkingLanguages || report.snapshot.hreflangs.length === 0} onClick={() => void checkLanguages()}>{checkingLanguages ? <Activity className="spinner" size={17} /> : <Languages size={17} />}检查相关语言页</button></div>
        {staticSnapshot?.internationalSeo.targets?.length ? <div className="language-target-list">{staticSnapshot.internationalSeo.targets.map((target) => <article key={`${target.lang}-${target.url}`}><span>{target.lang}</span><div><p>{target.url}</p><small>{target.issue || `状态 ${target.status}，互返正常`}</small></div></article>)}</div> : null}
        {staticFindings.filter((item) => /语言|hreflang|Canonical|国际/.test(item.title)).map((finding) => <article className={`overseas-finding priority-${finding.priority.toLocaleLowerCase()}`} key={finding.id}><div><span>{finding.priority}</span><h3>{finding.title}</h3></div><p><span>发现了什么</span>{finding.evidence}</p><p><span>为什么值得处理</span>{finding.why}</p><p><span>建议怎么修改</span>{finding.action}</p>{finding.codeExample ? <pre><code>{finding.codeExample}</code></pre> : null}<p><span>如何验证</span>{finding.verification}</p><p><span>平台后台还需确认</span>{finding.platformConfirmation}</p><details><summary>回滚与检测限制</summary><p>{finding.rollback}</p><p>{finding.limitation}</p></details></article>)}
      </section>
    </div> : null}

    {project && section === 'tracking' ? <div id="overseas-panel-tracking" role="tabpanel" aria-labelledby="overseas-tab-tracking" className="overseas-panel">
      <section className="tracking-explainer"><div className="sticker-icon"><Radio size={19} /></div><div><h2>现场确认事件有没有按预期发生</h2><p>点击开始后再到网页完成一次成功操作和一次失败操作。插件只记录事件名和关键字段是否存在，不保存表单内容、请求正文、Cookie 或业务 ID。</p></div>{currentRun?.status === 'running' ? <span className="rec-badge"><i />REC</span> : null}</section>
      <section className="plain-section evidence-layers"><div className="section-heading"><div><p className="section-kicker">证据分层</p><h2>“装了标签”不等于“收到有效转化”</h2></div></div><ol><li className={staticSnapshot?.tags.some((tag) => tag.scriptCount || tag.ids.length) ? 'observed' : ''}><span>1</span><p>页面存在标签<small>{staticSnapshot?.tags.some((tag) => tag.scriptCount || tag.ids.length) ? '已观察到标签或 ID' : '尚未取得证据'}</small></p></li><li className={staticSnapshot?.tags.some((tag) => tag.initialized) ? 'observed' : ''}><span>2</span><p>浏览器观察到初始化<small>{staticSnapshot?.tags.some((tag) => tag.initialized) ? '已观察到初始化' : '尚未取得证据'}</small></p></li><li className={staticSnapshot?.tags.some((tag) => tag.requestObserved) || currentRun?.observations.some((item) => item.type === 'request') ? 'observed' : ''}><span>3</span><p>浏览器观察到请求<small>{staticSnapshot?.tags.some((tag) => tag.requestObserved) || currentRun?.observations.some((item) => item.type === 'request') ? '已观察到请求' : '尚未取得证据'}</small></p></li><li><span>4</span><p>分析/广告后台确认收到<small>必须到平台后台确认</small></p></li><li><span>5</span><p>后端确认有效业务<small>必须用业务结果核对</small></p></li></ol></section>
      {staticSnapshot ? <section className="plain-section tag-snapshot"><div className="section-heading"><div><p className="section-kicker">Google 与 Bing</p><h2>页面标签和请求现场</h2></div></div><div className="tag-table" role="table" aria-label="分析与广告标签状态">{staticSnapshot.tags.map((tag) => <div role="row" key={tag.platform}><span role="cell">{PLATFORM_LABELS[tag.platform]}</span><span role="cell">{tag.ids.join('、') || '未识别 ID'}</span><span role="cell">{tag.initialized ? '已初始化' : tag.scriptCount ? '有脚本，未确认初始化' : '未发现'}</span><span role="cell">{tag.requestObserved ? '观察到请求' : '未观察到请求'}</span></div>)}</div><details><summary>Consent Mode 现场</summary><p>{staticSnapshot.consent.explanation}</p><dl>{Object.entries(staticSnapshot.consent.signals).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value || '未观察到'}</dd></div>)}</dl></details></section> : null}
      {staticFindings.filter((item) => !/语言|hreflang|Canonical|国际/.test(item.title)).map((finding) => <article className={`overseas-finding priority-${finding.priority.toLocaleLowerCase()}`} key={finding.id}><div><span>{finding.priority}</span><h3>{finding.title}</h3></div><p><span>发现了什么</span>{finding.evidence}</p><p><span>为什么值得处理</span>{finding.why}</p><p><span>建议怎么修改</span>{finding.action}</p>{finding.codeExample ? <pre><code>{finding.codeExample}</code></pre> : null}<p><span>如何验证</span>{finding.verification}</p><p><span>平台后台还需确认</span>{finding.platformConfirmation}</p><details><summary>回滚与检测限制</summary><p>{finding.rollback}</p><p>{finding.limitation}</p></details></article>)}
      <section className="plain-section"><div className="tracking-controls"><SelectField label="本次测试目标" value={goal} onChange={(value) => setGoal(value as TrackingTestRun['goal'])} options={[...GOAL_OPTIONS]} />{goal === 'custom' ? <label><span>自定义事件名</span><input value={customEvent} onChange={(event) => setCustomEvent(event.target.value)} placeholder="例如：book_demo" /></label> : null}<div className="button-row">{currentRun?.status === 'running' ? <button type="button" className="stop-button" disabled={busy} onClick={() => void stopTracking()}><Square size={17} />停止测试</button> : <button type="button" className="primary-button" disabled={!report || busy || (goal === 'custom' && !customEvent.trim())} onClick={() => void startTracking()}><Play size={17} />开始测试</button>}</div></div>
        {currentRun?.status === 'running' ? <div className="outcome-confirm"><p>在网页完成操作后，分别标记结果：</p><button type="button" className={currentRun.successfulActionObserved ? 'complete' : ''} onClick={() => void markOutcome('success')}><Check size={16} />成功操作已完成</button><button type="button" className={currentRun.failedActionObserved ? 'complete' : ''} onClick={() => void markOutcome('failure')}><AlertCircle size={16} />失败操作已完成</button></div> : null}
        {currentRun ? <div className="tracking-timeline" aria-label="追踪事件时间线">{currentRun.observations.length ? currentRun.observations.map((item) => <div className="tracking-event" key={item.id}><span>{Math.round(item.relativeMs / 100) / 10}s</span><div><p>{item.name}</p><small>{item.platform} · {item.type}{item.fields.sensitiveField ? ' · 疑似敏感字段' : ''}</small></div></div>) : <p className="empty-copy">尚未观察到事件。测试运行时请在原网页完成目标操作。</p>}</div> : <p className="empty-copy">还没有追踪测试。普通页面扫描不会持续监听，只有点击“开始测试”后才临时观察。</p>}
      </section>
      {trackingRuns.length ? <section className="plain-section"><div className="section-heading"><div><p className="section-kicker">本机历史</p><h2>最近追踪测试</h2></div></div><div className="tracking-history">{trackingRuns.slice(0, 20).map((run) => <div key={run.id}><span>{new Date(run.startedAt).toLocaleString('zh-CN')} · {run.status} · {run.observations.length} 条</span><button type="button" className="icon-button" aria-label="删除这次追踪测试" onClick={() => void deleteTrackingRun(run.id).then(() => refresh())}><Trash2 size={16} /></button></div>)}</div></section> : null}
    </div> : null}

    {project && section === 'reconciliation' ? <div id="overseas-panel-reconciliation" role="tabpanel" aria-labelledby="overseas-tab-reconciliation" className="overseas-panel">
      <section className="sem-data-intro"><div className="sticker-icon"><FileSpreadsheet size={19} /></div><div><h2>把点击、分析事件和真实业务对起来</h2><p>GA4 说明网站观察到了什么，广告报表说明平台记了什么，业务结果说明最终是否有效。只导入一种数据时，插件只报告事实和缺口。</p><p className="section-note">原始 CSV 不保存，邮箱、电话、姓名和地址列禁止映射。</p></div></section>
      <label className="wide-field reconciliation-currency"><span>数据比较币种</span><small>填写三份报表共同使用的币种，例如 USD。币种不一致时只比较数量，不比较收入和回报。</small><input aria-label="数据比较币种" value={project.currency} maxLength={3} onChange={(event) => void updateProject({ currency: event.target.value.toUpperCase().replace(/[^A-Z]/g, '') })} /></label>
      <div className="importer-grid"><CsvImporter kind="analytics_performance" project={project} onImported={(dataset) => setDatasets((current) => [dataset, ...current.filter((item) => item.id !== dataset.id)])} /><CsvImporter kind="sem_performance" project={project} onImported={(dataset) => setDatasets((current) => [dataset, ...current.filter((item) => item.id !== dataset.id)])} /><CsvImporter kind="business_outcome" project={project} onImported={(dataset) => setDatasets((current) => [dataset, ...current.filter((item) => item.id !== dataset.id)])} /></div>
      {datasets.filter((item) => ['analytics_performance', 'sem_performance', 'business_outcome'].includes(item.kind)).length ? <section className="plain-section"><div className="dataset-list">{datasets.filter((item) => ['analytics_performance', 'sem_performance', 'business_outcome'].includes(item.kind)).map((dataset) => <div className="dataset-row" key={dataset.id}><div><span>{dataset.name}</span><p>{dataset.kind} · {dataset.rowCount.toLocaleString()} 行</p></div><button type="button" className="icon-button" aria-label={`删除 ${dataset.name}`} onClick={() => void deleteDataset(dataset).then(() => refresh())}><Trash2 size={16} /></button></div>)}</div></section> : null}
      <button type="button" className="primary-button reconciliation-run" disabled={busy} onClick={() => void runReconciliation()}>{busy ? <Activity className="spinner" size={17} /> : <ShieldCheck size={17} />}运行三方数据核对</button>
      {reconciliation ? <section className="plain-section"><div className="reconciliation-funnel" aria-label="追踪数据漏斗">{[['广告点击', reconciliation.clicks], ['分析会话', reconciliation.sessions], ['分析关键事件', reconciliation.analyticsKeyEvents], ['平台转化', reconciliation.platformConversions], ['有效业务', reconciliation.validConversions]].map(([label, value]) => <div key={String(label)}><span>{label}</span><p>{Number(value).toLocaleString()}</p></div>)}</div><div className="reconciliation-basis" aria-label="三方核对口径"><p><span>可比较周期</span>{reconciliation.period?.start && reconciliation.period?.end ? `${reconciliation.period.start} 至 ${reconciliation.period.end}` : '没有成熟的重叠周期'}</p><p><span>项目时区 / 成熟期</span>{reconciliation.period?.timezone || project.timezone} / {reconciliation.period?.maturityDays ?? 1} 天</p><p><span>路径对齐</span>{reconciliation.alignment?.matchedLandingPages ?? 0} 个落地页在广告与 GA4 中匹配</p><p><span>业务归因</span>点击 ID {reconciliation.alignment?.highConfidenceRows ?? 0} · 唯一 UTM {reconciliation.alignment?.mediumConfidenceRows ?? 0} · 系列+日期 {reconciliation.alignment?.lowConfidenceRows ?? 0}</p><p><span>货币口径</span>{reconciliation.currencyComparable === false ? `不可比较：${reconciliation.observedCurrencies?.join('、') || '币种冲突'}` : `${reconciliation.currency || project.currency}，可按当前口径展示`}</p></div>{reconciliation.findings.map((finding) => <article className={`overseas-finding priority-${finding.priority.toLocaleLowerCase()}`} key={finding.id}><div><span>{finding.priority}</span><h3>{finding.title}</h3></div><p><span>证据来自哪里</span>{finding.evidence}</p><p><span>为什么值得处理</span>{finding.why}</p><p><span>建议怎么修改</span>{finding.action}</p>{finding.codeExample ? <pre><code>{finding.codeExample}</code></pre> : null}<p><span>如何验证</span>{finding.verification}</p><p><span>平台后台还需确认</span>{finding.platformConfirmation}</p><details><summary>回滚与检测限制</summary><p>{finding.rollback}</p><p>{finding.limitation}</p></details></article>)}{reconciliation.gaps.length ? <div className="data-gap-list"><h3>仍缺少的数据与口径说明</h3>{reconciliation.gaps.map((gap) => <p key={gap}>{gap}</p>)}</div> : null}</section> : null}
      <button type="button" className="text-button destructive-action" onClick={() => void clearOverseas()}><Trash2 size={16} />清除当前网站海外数据</button>
    </div> : null}
  </div>;
}
