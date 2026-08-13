import { AlertCircle, BarChart3, Check, ChevronDown, CircleHelp, FileClock, Globe2, Lightbulb, ListChecks, Pause, Play, RefreshCw, Save, SearchCheck, ShieldCheck, Square, Trash2, Upload, Wrench } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AuditContext, AuditReport, RuntimeMessage } from '../../src/lib/audit/types';
import { originPermissionPattern } from '../../src/lib/page-access';
import {
  createProjectForOrigin,
  deleteDataset,
  getProjectRows,
  getSitePages,
  latestSiteRun,
  listDatasets,
  latestLogSummary,
  saveSiteRun,
  saveLogSummary,
  saveProject,
} from '../../src/lib/projects/db';
import type { ImportDataset, SearchProject, SeoPerformanceRow, ServerLogSummary, SiteAuditIssue, SiteAuditRun } from '../../src/lib/projects/types';
import { summarizeSeoPerformance } from '../../src/lib/seo/performance';
import { createDataWorker, requestDataWorker } from '../../src/lib/imports/worker-client';
import { diagnoseServerLog } from '../../src/lib/logs/diagnostics';
import { getSiteIssueDisplayTitle, getSiteIssueGuidance } from '../../src/lib/site-audit/guidance';
import { CsvImporter } from './CsvImporter';
import { SelectField } from './SelectField';

async function runtime<T>(message: RuntimeMessage): Promise<T> {
  const response = await chrome.runtime.sendMessage(message) as { ok: boolean; result?: T; error?: string };
  if (!response?.ok) throw new Error(response?.error || '扩展请求失败。');
  return response.result as T;
}

const SITE_AUDIT_STATUS: Record<SiteAuditRun['status'], string> = {
  queued: '等待开始',
  running: '检查中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  failed: '检查失败',
};

const SITE_PRIORITY_LABEL: Record<SiteAuditIssue['priority'], string> = {
  P0: '必须先处理',
  P1: '高影响',
  P2: '建议优化',
  P3: '持续观察',
};

function SiteAuditIssueCard({ issue }: { issue: SiteAuditIssue }) {
  const guidance = getSiteIssueGuidance(issue);
  return (
    <article className={`site-issue-card site-priority-${issue.priority.toLowerCase()}`}>
      <div className="site-issue-header">
        <span className="site-issue-priority">{issue.priority} · {SITE_PRIORITY_LABEL[issue.priority]}</span>
        <div>
          <h3>{getSiteIssueDisplayTitle(issue)}</h3>
          <p className="site-issue-evidence">{issue.evidence}{issue.sampled ? ' 这是根据本次样本发现的候选问题，需要结合页面用途确认。' : ''}</p>
        </div>
      </div>
      <div className="site-issue-guidance">
        <div className="site-issue-guidance-row">
          <CircleHelp size={17} aria-hidden="true" />
          <div><span>为什么要处理</span><p>{guidance.impact}</p></div>
        </div>
        <div className="site-issue-guidance-row">
          <Wrench size={17} aria-hidden="true" />
          <div><span>建议怎么做</span><p>{guidance.recommendation}</p></div>
        </div>
        <div className="site-issue-guidance-row">
          <ShieldCheck size={17} aria-hidden="true" />
          <div><span>怎么验证已经修好</span><p>{guidance.verification}</p></div>
        </div>
      </div>
      {issue.affectedUrls.length ? (
        <details className="site-issue-urls">
          <summary><ListChecks size={17} aria-hidden="true" /><span>查看受影响的 {issue.affectedUrls.length} 个页面</span><ChevronDown className="details-chevron" size={17} aria-hidden="true" /></summary>
          <ul>{issue.affectedUrls.map((url) => <li key={url}><code>{url}</code></li>)}</ul>
        </details>
      ) : null}
    </article>
  );
}

export function SeoGrowthSections({ report, onContextUpdated, onRescan, mode = 'summary' }: {
  report: AuditReport;
  onContextUpdated: (report: AuditReport) => void;
  onRescan: (context: AuditContext) => Promise<void>;
  mode?: 'summary' | 'site-audit';
}) {
  const [project, setProject] = useState<SearchProject | null>(null);
  const [context, setContext] = useState<AuditContext>(report.context);
  const [siteRun, setSiteRun] = useState<SiteAuditRun | null>(null);
  const [siteLimit, setSiteLimit] = useState<20 | 50 | 100>(20);
  const [seoDatasets, setSeoDatasets] = useState<ImportDataset[]>([]);
  const [seoRows, setSeoRows] = useState<SeoPerformanceRow[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [contextFeedback, setContextFeedback] = useState('');
  const [watchingSiteAudit, setWatchingSiteAudit] = useState(false);
  const [advancedRangeOpen, setAdvancedRangeOpen] = useState(false);
  const [logSummary, setLogSummary] = useState<ServerLogSummary | null>(null);
  const logWorkerRef = useRef<Worker | null>(null);
  const [logProgress, setLogProgress] = useState<{ value: number; stage: string } | null>(null);

  useEffect(() => () => logWorkerRef.current?.terminate(), []);

  const refreshProjectData = useCallback(async (current: SearchProject) => {
    if (mode === 'site-audit') {
      const [run, logs] = await Promise.all([latestSiteRun(current.id), latestLogSummary(current.id)]);
      setSiteRun(run ?? null);
      setLogSummary(logs ?? null);
      if (run) setSiteLimit(run.limit);
      return;
    }
    const [datasets, rows] = await Promise.all([
      listDatasets(current.id),
      getProjectRows<SeoPerformanceRow>('seo_performance', current.id),
    ]);
    setSeoDatasets(datasets.filter((item) => item.kind === 'seo_performance'));
    setSeoRows(rows);
  }, [mode]);

  useEffect(() => {
    let active = true;
    void createProjectForOrigin(new URL(report.url).origin).then(async (current) => {
      if (!active) return;
      setProject(current);
      await refreshProjectData(current);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : '无法加载项目。'));
    return () => { active = false; };
  }, [report.url, refreshProjectData]);

  useEffect(() => {
    if (!project || (!watchingSiteAudit && siteRun?.status !== 'running')) return;
    let active = true;
    const syncRun = async () => {
      const latest = await latestSiteRun(project.id);
      if (!active || !latest) return;
      const background = await runtime<{ active: boolean }>({ type: 'GET_SITE_AUDIT_ACTIVE', projectId: project.id });
      if (!active) return;
      if (latest.status === 'running' && !background.active) {
        const interrupted = { ...latest, status: 'paused' as const, updatedAt: new Date().toISOString(), error: '后台已重载，可从剩余 URL 继续。' };
        await saveSiteRun(interrupted);
        if (active) setSiteRun(interrupted);
        setWatchingSiteAudit(false);
        return;
      }
      setSiteRun(latest);
      if (latest.status !== 'running' && latest.status !== 'queued') setWatchingSiteAudit(false);
    };
    void syncRun();
    const timer = window.setInterval(() => void syncRun(), 300);
    return () => { active = false; window.clearInterval(timer); };
  }, [project?.id, siteRun?.status, watchingSiteAudit]);

  useEffect(() => setContext(report.context), [report.id, report.context]);
  useEffect(() => {
    const listener = (message: RuntimeMessage) => {
      if (message.type === 'SITE_AUDIT_CHANGED' && message.projectId === project?.id) setSiteRun(message.run);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [project?.id]);

  const summary = useMemo(() => summarizeSeoPerformance(seoRows), [seoRows]);
  const saveContext = async () => {
    setSaving(true);
    setError('');
    setContextFeedback('');
    try {
      const next = await runtime<AuditReport>({ type: 'UPDATE_REPORT_CONTEXT', report, context });
      const previousFindings = new Map(report.findings.map((finding) => [finding.id, finding]));
      const changed = next.findings.filter((finding) => {
        const previous = previousFindings.get(finding.id);
        return !previous
          || previous.status !== finding.status
          || previous.priority !== finding.priority
          || previous.scoreRatio !== finding.scoreRatio
          || previous.evidence !== finding.evidence;
      }).length;
      const scoreChange = `${report.overallScore ?? '—'} → ${next.overallScore ?? '—'}`;
      const changedFields = (Object.keys(context) as Array<keyof AuditContext>)
        .filter((key) => context[key] !== report.context[key]);
      const onlyExplanatoryFields = changedFields.length > 0
        && changedFields.every((key) => key === 'targetQuery' || key === 'pageTask');
      setContextFeedback(
        changed > 0
          ? `页面目标已保存，页面 SEO 基础分 ${scoreChange}，${changed} 条规则证据或结论发生变化。`
          : onlyExplanatoryFields
            ? `页面目标已保存，页面 SEO 基础分 ${scoreChange}。目标查询和页面任务用于相关性判断，不直接计入基础分。`
            : `页面目标已保存，页面 SEO 基础分 ${scoreChange}，本次规则结论没有变化。`,
      );
      onContextUpdated(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '页面上下文保存失败。'); }
    finally { setSaving(false); }
  };

  const rescanPage = async () => {
    setRescanning(true);
    setError('');
    setContextFeedback('');
    try {
      await onRescan(context);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '页面重新扫描失败。');
    } finally {
      setRescanning(false);
    }
  };

  const startSiteAudit = async (resume = false) => {
    if (!project) return;
    setError('');
    try {
      const originPattern = originPermissionPattern(project.origin);
      // Request directly while the click still carries a user gesture. Chrome returns
      // true immediately when the origin is already granted.
      const granted = await chrome.permissions.request({ origins: [originPattern] });
      if (!granted) throw new Error('站点审计需要当前项目主域名的读取权限。');
      setWatchingSiteAudit(true);
      await runtime({ type: 'START_SITE_AUDIT', project, limit: siteLimit, currentUrl: report.url, resume });
    } catch (reason) { setWatchingSiteAudit(false); setError(reason instanceof Error ? reason.message : '无法启动站点审计。'); }
  };

  const cancelSiteAudit = async () => {
    if (!project) return;
    await runtime({ type: 'CANCEL_SITE_AUDIT', projectId: project.id });
  };

  const importLog = async (file: File) => {
    if (!project) return;
    setError('');
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('日志超过 20MB，请按日期拆分后再导入。');
      setLogProgress({ value: 5, stage: '正在读取日志' });
      const pages = siteRun ? await getSitePages(siteRun.id) : [];
      const content = await file.text();
      logWorkerRef.current ??= createDataWorker();
      const summary = await requestDataWorker<ServerLogSummary>(logWorkerRef.current, {
        id: crypto.randomUUID(),
        type: 'PARSE_LOG',
        projectId: project.id,
        content,
        sitemapUrls: pages.filter((page) => page.inSitemap).map((page) => page.url),
      }, (value, stage) => setLogProgress({ value, stage }));
      await saveLogSummary(summary);
      setLogSummary(summary);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '日志导入失败。'); }
    finally { setLogProgress(null); }
  };

  const cancelLogImport = () => {
    logWorkerRef.current?.terminate();
    logWorkerRef.current = null;
    setLogProgress(null);
    setError('已取消日志处理，原始日志没有保存。');
  };

  const saveProjectBasics = async (patch: Partial<SearchProject>) => {
    if (!project) return;
    const next = { ...project, ...patch, updatedAt: new Date().toISOString() };
    setProject(next);
    await saveProject(next);
  };

  return (
    <>
      {mode === 'summary' ? <section className="plain-section page-context-section" aria-labelledby="page-context-title">
        <div className="section-heading"><div><p className="section-kicker">告诉插件这页要完成什么</p><h2 id="page-context-title">页面目标</h2></div><SearchCheck size={18} /></div>
        <p className="section-note concept-note">这些设置不会修改网站，只会帮助插件按正确目标判断。例如登录页通常不需要出现在搜索结果中，产品页和文章页的检查重点也不同。</p>
        <div className="context-grid">
          <SelectField label="是否希望被搜索到" value={context.expectedIndexState} onChange={(value) => setContext((current) => ({ ...current, expectedIndexState: value as AuditContext['expectedIndexState'] }))} options={[{ value: 'unknown', label: '还不确定', description: '暂不把 noindex 或 404 判为阻断' }, { value: 'index', label: '希望被搜索到', description: '按公开搜索页面检查' }, { value: 'noindex', label: '不需要被搜索到', description: '适合登录页、内部工具等' }]} />
          <SelectField label="这是什么页面" value={context.pageType} onChange={(value) => setContext((current) => ({ ...current, pageType: value as AuditContext['pageType'] }))} options={[{ value: 'auto', label: '让插件自动判断' }, { value: 'article', label: '文章 / 教程' }, { value: 'product_service', label: '产品 / 服务' }, { value: 'category', label: '分类 / 列表' }, { value: 'internal_app', label: '登录后工具 / 内部页' }]} />
          <label><span>用户可能搜索什么</span><input value={context.targetQuery} placeholder="例如：企业 SEO 审计" onChange={(event) => setContext((current) => ({ ...current, targetQuery: event.target.value }))} /><small>用于判断标题、主标题和首屏是否回答同一个需求，不检查关键词密度。</small></label>
          <label><span>用户进入后要完成什么</span><input value={context.pageTask} placeholder="例如：了解服务并提交咨询" onChange={(event) => setContext((current) => ({ ...current, pageTask: event.target.value }))} /><small>用于判断页面内容和行动入口是否兑现搜索结果里的承诺。</small></label>
        </div>
        <div className="context-actions">
          <button type="button" className="secondary-button context-save" disabled={saving || rescanning} onClick={() => void saveContext()}><Save size={17} />{saving ? '正在计算…' : '保存目标并重新计算'}</button>
          <button type="button" className="secondary-button context-rescan" disabled={saving || rescanning} onClick={() => void rescanPage()}><RefreshCw className={rescanning ? 'spinner' : ''} size={17} />{rescanning ? '正在扫描…' : '重新扫描页面'}</button>
        </div>
        {contextFeedback ? <div className="context-feedback" role="status"><Check size={16} /><span>{contextFeedback}</span></div> : null}
        {error ? <div className="inline-alert" role="alert"><AlertCircle size={16} />{error}</div> : null}
      </section> : null}

      {mode === 'summary' && project ? <section className="plain-section project-seo-section" aria-labelledby="project-seo-title">
        <div className="section-heading"><div><p className="section-kicker">搜索项目</p><h2 id="project-seo-title">{project.name}</h2></div><Globe2 size={18} /></div>
        <div className="project-form-grid compact">
          <label><span>市场</span><input value={project.market} onChange={(event) => void saveProjectBasics({ market: event.target.value })} /></label>
          <label><span>时区</span><input value={project.timezone} onChange={(event) => void saveProjectBasics({ timezone: event.target.value })} /></label>
          <label><span>货币</span><input value={project.currency} maxLength={3} onChange={(event) => void saveProjectBasics({ currency: event.target.value.toUpperCase() })} /></label>
          <label><span>品牌词</span><input value={project.brandTerms.join(', ')} placeholder="逗号分隔" onChange={(event) => void saveProjectBasics({ brandTerms: event.target.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean) })} /></label>
        </div>
      </section> : null}

      {mode === 'site-audit' && !project ? <section className="plain-section site-audit-section" aria-labelledby="site-audit-loading-title">
        <div className="section-heading"><div><p className="section-kicker">发现网站的共性问题</p><h2 id="site-audit-loading-title">站点审计</h2></div><Globe2 size={18} /></div>
        {error ? <div className="inline-alert" role="alert"><AlertCircle size={16} />{error}</div> : <p className="empty-copy" role="status">正在加载当前网站的审计项目…</p>}
      </section> : null}

      {mode === 'site-audit' && project ? <section className="plain-section site-audit-section" aria-labelledby="site-audit-title">
        <div className="section-heading"><div><p className="section-kicker">发现同一网站的批量问题</p><h2 id="site-audit-title">站点审计</h2></div><Globe2 size={18} /></div>
        <div className="site-audit-explainer" role="note">
          <SearchCheck size={19} aria-hidden="true" />
          <div className="site-audit-explainer-content">
            <p className="site-audit-explainer-title">它能帮你做什么？</p>
            <p>当前页面检查只看你正在浏览的这一页。站点审计会从同一网站选择首页、当前页、页面清单（Sitemap）和不同页面模板的代表地址进行对比，帮你判断问题是单页写错，还是模板或配置写错、会同时影响一批页面。找到共性问题后，通常改一次模板或配置，就能一起修复多个页面。</p>
            <ul>
              <li><AlertCircle size={16} aria-hidden="true" /><span>找出打不开、明确要求不收录，或“首选地址（Canonical）”配错的页面。</span></li>
              <li><Lightbulb size={16} aria-hidden="true" /><span>发现一批页面是否误用了相同标题、描述或正文模板。</span></li>
              <li><ListChecks size={16} aria-hidden="true" /><span>检查网站页面清单（Sitemap）里的重要页面，是否有其他站内页面链接到它。</span></li>
            </ul>
            <p className="site-audit-boundary"><CircleHelp size={15} aria-hidden="true" />默认快速检查 20 页，目的是先判断是否存在批量问题，不会把整个网站全部爬完。结果代表本次样本，不能直接证明搜索引擎已经收录、排名，也不能判断外链或转化效果。</p>
          </div>
        </div>
        <p className="section-note">第一次直接运行 20 页快速检查即可。完成后如果发现多个模板或网站页面较多，再扩大到 50 或 100 页确认影响范围。</p>
        {error ? <div className="inline-alert" role="alert"><AlertCircle size={16} />{error}</div> : null}
        <div className="site-audit-controls">
          {advancedRangeOpen ? <SelectField label="检查范围" value={String(siteLimit)} onChange={(value) => setSiteLimit(Number(value) as 20 | 50 | 100)} options={[{ value: '20', label: '快速检查 · 最多 20 页', description: '先快速判断是否存在明显共性问题' }, { value: '50', label: '标准检查 · 最多 50 页', description: '用于确认模板问题的影响范围' }, { value: '100', label: '深入检查 · 最多 100 页', description: '页面类型较多时进一步抽样' }]} /> : <button type="button" className="text-button" onClick={() => setAdvancedRangeOpen(true)}>调整检查范围</button>}
          {siteRun?.status === 'running' ? <button type="button" className="secondary-button" onClick={() => void cancelSiteAudit()}><Pause size={17} />暂停</button> : <button type="button" className="primary-button" onClick={() => void startSiteAudit(siteRun?.status === 'paused' || siteRun?.status === 'failed')}><Play size={17} />{siteRun?.status === 'paused' || siteRun?.status === 'failed' ? '继续检查' : `快速检查 ${siteLimit} 页`}</button>}
        </div>
        {siteRun ? <div className="site-run-summary"><div><span>状态</span><p>{SITE_AUDIT_STATUS[siteRun.status]}</p></div><div><span>已检查</span><p>{siteRun.pages}/{siteRun.limit}</p></div><div><span>页面模板</span><p>{siteRun.inventory?.templateClusters.length ?? '—'}</p></div><div><span>共性问题</span><p>{siteRun.issues.length}</p></div></div> : <p className="empty-copy">尚未检查。点击“快速检查 20 页”，插件会自动挑选不同类型的代表页面进行比较。</p>}
        {siteRun?.inventory ? <div className="site-inventory-strip"><span>页面清单 {siteRun.inventory.sitemap.discovered ? `${siteRun.inventory.sitemap.urlCount} 个地址` : '未找到'}</span><span>压缩清单 {siteRun.inventory.sitemap.compressedFiles}</span><span>日期错误 {siteRun.inventory.sitemap.invalidLastmod}</span><span>参数 URL {siteRun.inventory.queryUrlCount}</span><span>空正文 {siteRun.inventory.emptyContentCount}</span><span>疑似孤立 {siteRun.inventory.orphanCandidates}</span></div> : null}
        {siteRun?.status === 'completed' && siteRun.limit === 20 && (siteRun.issues.length > 0 || (siteRun.inventory?.templateClusters.length ?? 0) >= 3) ? <div className="expand-audit-note"><Lightbulb size={17} /><span>快速检查已发现共性问题或多个页面模板。需要确认影响范围时，可把检查范围扩大到 50 页；不必一开始就检查 100 页。</span><button type="button" className="text-button" onClick={() => { setAdvancedRangeOpen(true); setSiteLimit(50); }}>扩大到 50 页</button></div> : null}
        {siteRun?.issues.length ? <div className="site-issue-list" aria-label="站点审计问题和处理建议">{siteRun.issues.map((issue) => <SiteAuditIssueCard key={issue.id} issue={issue} />)}</div> : siteRun?.status === 'completed' ? <div className="site-audit-empty"><Check size={18} aria-hidden="true" /><div><span>本次样本没有发现站点级共性问题</span><p>这只代表已检查的 {siteRun.pages} 个页面，没有发现当前规则覆盖的问题，不等于全站一定没有问题。</p></div></div> : null}
        {siteRun?.inventory?.internalLinkOpportunities.length ? <details className="advanced-data-section internal-link-opportunities"><summary><Lightbulb size={17} /><span>查看 {siteRun.inventory.internalLinkOpportunities.length} 条内链机会</span><ChevronDown className="details-chevron" size={17} /></summary><div><p>这些建议根据本次采样页面的主题词和链接关系生成，不能代替完整全站爬虫。添加前先确认来源页上下文自然、目标页确实值得被搜索。</p><div className="link-opportunity-list">{siteRun.inventory.internalLinkOpportunities.map((item) => <article key={item.id}><span>{item.confidence === 'medium' ? '中' : '低'}置信度 · 采样建议</span><p><code>{item.sourceUrl}</code><span>链接到</span><code>{item.targetUrl}</code></p><p>建议锚文本：{item.suggestedAnchor || '按目标页主题自然描述'}</p><small>{item.reason}</small></article>)}</div></div></details> : null}
        <details className="advanced-data-section"><summary><FileClock size={17} />可选：导入服务器日志验证抓取情况<ChevronDown className="details-chevron" size={17} /></summary><div><p>只在需要判断疑似搜索爬虫访问、错误状态、慢 URL 或参数浪费时使用。插件只保存聚合结果，不保存 IP、Referer、原始 User-Agent 或原文件。</p><label className={`secondary-button log-upload${logProgress ? ' disabled' : ''}`}><Upload size={17} />选择 Nginx / CDN 日志<input disabled={Boolean(logProgress)} type="file" accept=".log,.txt,.csv,text/plain,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importLog(file); event.currentTarget.value = ''; }} /></label>{logProgress ? <div className="import-progress" role="status"><div><span>{logProgress.stage}</span><span>{logProgress.value}%</span></div><progress max="100" value={logProgress.value} /><button type="button" className="text-button" onClick={cancelLogImport}><Square size={15} />取消</button></div> : null}{logSummary ? <div className="log-summary"><span>{logSummary.requestCount.toLocaleString()} 次请求</span><span>{logSummary.botFamilies.reduce((sum, item) => sum + item.requests, 0).toLocaleString()} 次疑似爬虫</span><span>{logSummary.slowUrlCandidates.length} 个慢 URL</span><span>{logSummary.wastedUrlCandidates.length} 个浪费候选</span></div> : null}{logSummary ? <div className="log-diagnostics">{diagnoseServerLog(logSummary).map((item) => <p key={item.code}><span>{item.priority} · {item.title}</span>{item.evidence} {item.action}</p>)}</div> : null}</div></details>
      </section> : null}

      {mode === 'summary' && project ? <section className="plain-section seo-performance-section" aria-labelledby="seo-performance-title">
        <div className="section-heading"><div><p className="section-kicker">GSC / Bing / 百度</p><h2 id="seo-performance-title">SEO 搜索表现</h2></div><BarChart3 size={18} /></div>
        <div className="seo-summary-grid"><div><span>展现</span><p>{summary.impressions.toLocaleString()}</p></div><div><span>点击</span><p>{summary.clicks.toLocaleString()}</p></div><div><span>CTR</span><p>{(summary.ctr * 100).toFixed(2)}%</p></div><div><span>平均位置</span><p>{summary.averagePosition?.toFixed(1) ?? '—'}</p></div></div>
        <p className="section-note">搜索表现不进入页面 SEO 基础分，只用于验证查询、点击和页面冲突并调整优先级。</p>
        <CsvImporter kind="seo_performance" project={project} onImported={() => refreshProjectData(project)} />
        {seoDatasets.length ? <div className="dataset-list">{seoDatasets.map((dataset) => <div className="dataset-row" key={dataset.id}><div><span>{dataset.name}</span><p>{dataset.platform} · {dataset.rowCount.toLocaleString()} 行</p></div><button type="button" className="icon-button" aria-label={`删除 ${dataset.name}`} title={`删除 ${dataset.name}`} onClick={() => void deleteDataset(dataset).then(() => refreshProjectData(project))}><Trash2 size={17} /></button></div>)}</div> : null}
        {summary.cannibalizationCandidates.length ? <div className="query-conflicts"><h3>查询页面冲突候选</h3>{summary.cannibalizationCandidates.slice(0, 5).map((item) => <p key={item.query}><span>{item.query}</span>{item.pages.length} 个页面 · {item.impressions.toLocaleString()} 展现</p>)}</div> : null}
        {summary.opportunities?.length ? <div className="seo-opportunities"><h3>优先机会</h3>{summary.opportunities.slice(0, 6).map((item) => <article key={item.id}><span>{item.priority} · {item.confidence === 'high' ? '高' : item.confidence === 'medium' ? '中' : '低'}置信度</span><h4>{item.title}</h4><p>{item.evidence}</p><p>{item.action}</p></article>)}</div> : null}
        {summary.pageMatrix?.length ? <details className="page-matrix"><summary>查看 URL 级搜索表现矩阵<ChevronDown className="details-chevron" size={17} /></summary><div>{summary.pageMatrix.slice(0, 20).map((page) => <p key={page.page}><code>{page.page}</code><span>{page.impressions.toLocaleString()} 展现 · {page.clicks.toLocaleString()} 点击 · CTR {(page.ctr * 100).toFixed(2)}% · 位置 {page.averagePosition?.toFixed(1) ?? '—'}</span></p>)}</div></details> : null}
      </section> : null}
    </>
  );
}
