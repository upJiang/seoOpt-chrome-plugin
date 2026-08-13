import { AlertCircle, BarChart3, CalendarClock, Check, Circle, FileSpreadsheet, Gauge, Megaphone, MousePointerClick, Plus, Search, Settings2, Trash2 } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useState } from 'react';

import {
  createProjectForOrigin,
  clearAllProjectData,
  deleteProject,
  deleteDataset,
  getProjectRows,
  latestSemReport,
  listChangeRecords,
  listDatasets,
  listProjects,
  saveChangeRecord,
  saveProject,
  saveSemReport,
} from '../../src/lib/projects/db';
import { buildProjectExport, projectExportMarkdown } from '../../src/lib/projects/export';
import type {
  BusinessOutcomeRow,
  ChangeRecord,
  ImportDataset,
  SearchProject,
  SemCreativeRow,
  SemDiagnosticReport,
  SemPerformanceRow,
} from '../../src/lib/projects/types';
import { diagnoseSem } from '../../src/lib/sem/diagnostics';
import type { AuditReport } from '../../src/lib/audit/types';
import { clearAiConversation } from '../../src/lib/storage';
import { CsvImporter } from './CsvImporter';
import { ProjectCreateDialog } from './ProjectCreateDialog';
import { SelectField } from './SelectField';

type Section = 'summary' | 'landing' | 'data' | 'diagnosis';

const SEM_SECTIONS = [
  ['summary', '概况', Gauge],
  ['landing', '落地页', MousePointerClick],
  ['data', '数据', FileSpreadsheet],
  ['diagnosis', '诊断', BarChart3],
] as const;

const STATUS_LABELS = { good: '证据良好', attention: '需要关注', risk: '高风险', insufficient: '数据不足' } as const;
const STAGE_LABELS = { tracking: '先确认数据', search_terms: '检查搜索词', cost: '看成本变化', creative_landing: '对照广告和页面', business: '核对真实业务', budget: '判断是否值得花钱' } as const;
const STATUS_EXPLANATIONS = {
  tracking: '广告平台记录的转化，能不能和真实线索或订单对上。',
  searchTerms: '花钱买来的搜索词，是否真的符合你的目标客户需求。',
  creativeLanding: '广告写出的承诺，点击后页面是否真的接住并兑现。',
  conversionQuality: '平台报出的转化，是否最终产生有效业务，而不是重复或无效事件。',
  commercialSustainability: '扣除广告成本、退款后，结果是否符合你填写的获客成本、收入回报或毛利目标。',
} as const;

function phraseCoverage(phrase: string, value: string): number {
  const tokens = phrase.toLocaleLowerCase().match(/[\p{Script=Han}]{2,}|[a-z0-9]{2,}/gu) ?? [];
  if (!tokens.length) return 0;
  const normalizedValue = value.toLocaleLowerCase();
  return tokens.filter((token) => normalizedValue.includes(token)).length / tokens.length;
}

function landingPageChecks(report: AuditReport | null, targetQuery: string, adPromise: string) {
  if (!report) return [];
  const snapshot = report.snapshot;
  const parsed = new URL(report.url);
  const query = targetQuery.trim();
  const pagePromise = [snapshot.titleTags[0] || '', snapshot.headings.find((item) => item.level === 1)?.text || '', snapshot.visibleTextPreview].join(' ');
  const parameterNames = [...parsed.searchParams.keys()].map((item) => item.toLocaleLowerCase());
  const clickParameters = parameterNames.filter((name) => ['gclid', 'gbraid', 'wbraid', 'msclkid', 'bd_vid', 'utm_source', 'utm_campaign'].includes(name));
  const finalUrl = snapshot.siteProbe.page.finalUrl;
  const redirected = Boolean(finalUrl && finalUrl !== report.url);
  const finalParameters = redirected ? new Set([...new URL(finalUrl).searchParams.keys()].map((item) => item.toLocaleLowerCase())) : new Set<string>();
  const preservedParameters = clickParameters.filter((name) => finalParameters.has(name));
  const technical = snapshot.technical;
  const redirectRisk = technical?.transport.variants.some((variant) => variant.error || variant.redirectCount > 3 || (() => {
    try { return new URL(variant.finalUrl).protocol !== 'https:'; } catch { return true; }
  })());
  const resourceRiskCount = technical
    ? technical.resources.blockingScripts + technical.resources.blockingStylesheets + technical.resources.duplicateUrls.length
    : 0;
  return [
    { label: 'HTTPS 与最终落地地址', state: !technical ? 'insufficient' : technical.transport.secureContext && technical.transport.status !== 'attention' ? 'good' : 'risk', evidence: !technical ? '缺少服务器与最终地址证据。' : technical.transport.explanation },
    { label: '跳转链是否稳定', state: !technical?.transport.variants.length ? 'insufficient' : redirectRisk ? 'risk' : 'good', evidence: !technical?.transport.variants.length ? '尚未运行“完整检查网站入口”，无法判断多入口和跳转链。' : redirectRisk ? '发现降级、过长、循环或无法完成的跳转候选。' : '已检查的网站入口均收敛到稳定的最终地址。' },
    { label: '页面加载交付风险', state: !technical ? 'insufficient' : resourceRiskCount || technical.compression.status === 'attention' ? 'attention' : 'good', evidence: !technical ? '缺少页面资源证据。' : resourceRiskCount ? `发现 ${resourceRiskCount} 个阻塞或重复资源候选；需结合真实加载验证。` : technical.compression.explanation },
    { label: '目标查询与页面承诺', state: !query ? 'insufficient' : phraseCoverage(query, pagePromise) >= 0.5 ? 'good' : 'attention', evidence: !query ? '尚未填写 SEM 目标查询。' : `检查 title、H1 与首屏是否自然承接“${targetQuery}”，不要求机械重复。` },
    { label: '广告承诺与页面一致性', state: !adPromise.trim() ? 'insufficient' : phraseCoverage(adPromise, pagePromise) >= 0.5 ? 'good' : 'attention', evidence: !adPromise.trim() ? '尚未填写广告中承诺的价格、能力或结果。' : `核对页面是否兑现广告承诺：“${adPromise}”。` },
    { label: '主要行动 CTA', state: snapshot.ctaTexts.length ? 'good' : 'attention', evidence: snapshot.ctaTexts.length ? `检测到 ${snapshot.ctaTexts.length} 个可识别行动入口。` : '未检测到清晰按钮或行动链接。' },
    { label: '表单与转化路径', state: snapshot.formCount ? 'good' : 'insufficient', evidence: snapshot.formCount ? `检测到 ${snapshot.formCount} 个表单。` : '当前 DOM 未发现表单；电话、跳转下单等路径需人工确认。' },
    { label: '移动访问准备', state: /width\s*=\s*device-width/i.test(snapshot.viewportMeta) ? 'good' : 'risk', evidence: snapshot.viewportMeta || '缺少 viewport。' },
    { label: '广告追踪参数', state: clickParameters.length ? 'good' : 'insufficient', evidence: clickParameters.length ? `检测到点击参数：${clickParameters.join('、')}` : '当前页面没有 gclid、msclkid、百度点击标识或 UTM 参数。' },
    { label: '跳转后参数保留', state: !redirected || !clickParameters.length ? 'insufficient' : preservedParameters.length === clickParameters.length ? 'good' : 'risk', evidence: !redirected ? '本次没有跨 URL 跳转，无法验证参数跨跳转保留。' : !clickParameters.length ? '发生了跳转，但入口 URL 没有可比较的点击参数。' : `跳转后保留 ${preservedParameters.length}/${clickParameters.length} 个点击参数。` },
  ];
}

export function SemWorkspace({ report }: { report: AuditReport | null }) {
  const [section, setSection] = useState<Section>('summary');
  const [projects, setProjects] = useState<SearchProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [datasets, setDatasets] = useState<ImportDataset[]>([]);
  const [diagnosis, setDiagnosis] = useState<SemDiagnosticReport | null>(null);
  const [changeRecords, setChangeRecords] = useState<ChangeRecord[]>([]);
  const [changeDimension, setChangeDimension] = useState('budget');
  const [changeSummary, setChangeSummary] = useState('');
  const [learningDays, setLearningDays] = useState('7');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const project = projects.find((item) => item.id === projectId) ?? null;

  const refresh = useCallback(async (preferredId?: string) => {
    let next = await listProjects();
    if (!next.length && report) {
      await createProjectForOrigin(new URL(report.url).origin);
      next = await listProjects();
    }
    setProjects(next);
    const nextId = preferredId || projectId || next[0]?.id || '';
    setProjectId(nextId);
    if (nextId) {
      const [nextDatasets, nextDiagnosis, nextChanges] = await Promise.all([listDatasets(nextId), latestSemReport(nextId), listChangeRecords(nextId)]);
      setDatasets(nextDatasets);
      setDiagnosis(nextDiagnosis ?? null);
      setChangeRecords(nextChanges.filter((record) => record.channel === 'sem'));
    } else {
      setDatasets([]);
      setDiagnosis(null);
      setChangeRecords([]);
    }
  }, [projectId, report]);

  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (projectId) void refresh(projectId); }, [projectId]);

  const createProject = async (origin: string) => {
    const existing = projects.find((item) => item.origin === origin);
    const created = await createProjectForOrigin(origin);
    await refresh(created.id);
    setError('');
    setNotice(existing ? `已切换到 ${created.name}` : `已创建 ${created.name}，现在可以导入广告与业务数据。`);
  };

  const updateProject = async (patch: Partial<SearchProject>) => {
    if (!project) return;
    const next = { ...project, ...patch, updatedAt: new Date().toISOString() };
    await saveProject(next);
    setProjects((current) => current.map((item) => item.id === next.id ? next : item));
  };

  const runDiagnosis = async () => {
    if (!project) return;
    const [performance, business, creatives, changes] = await Promise.all([
      getProjectRows<SemPerformanceRow>('sem_performance', project.id),
      getProjectRows<BusinessOutcomeRow>('business_outcome', project.id),
      getProjectRows<SemCreativeRow>('sem_creative', project.id),
      listChangeRecords(project.id),
    ]);
    const result = diagnoseSem(project, performance, business, creatives, changes);
    await saveSemReport(result);
    setDiagnosis(result);
    setSection('diagnosis');
  };

  const semTargetQuery = project?.sem.landingTargetQuery || report?.context.targetQuery || '';
  const checks = useMemo(() => landingPageChecks(report, semTargetQuery, project?.sem.adPromise || ''), [project?.sem.adPromise, report, semTargetQuery]);
  const semDatasets = datasets.filter((item) => item.kind !== 'seo_performance');
  const handleDatasetImported = (dataset: ImportDataset) => {
    setDatasets((current) => [dataset, ...current.filter((item) => item.id !== dataset.id)]);
  };
  const onboardingSteps = [
    { label: '填写什么算有效、什么算划算', complete: Boolean(project?.primaryConversion && (project.sem.targetCpa !== null || project.sem.targetRoas !== null || project.sem.grossProfitPerConversion !== null)), action: () => document.getElementById('sem-basics')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }) },
    { label: '导入广告平台 CSV', complete: datasets.some((item) => item.kind === 'sem_performance'), action: () => setSection('data') },
    { label: '查看问题和下一步', complete: Boolean(diagnosis), action: () => setSection(diagnosis ? 'diagnosis' : 'data') },
  ];
  const recordSemChange = async () => {
    if (!project || !changeSummary.trim()) {
      setError('请先写清楚本次只改变了什么。');
      return;
    }
    const days = Math.min(90, Math.max(1, Number(learningDays) || 7));
    const createdAt = new Date();
    const learningUntil = new Date(createdAt.getTime() + days * 86_400_000).toISOString();
    const record: ChangeRecord = {
      id: crypto.randomUUID(),
      projectId: project.id,
      type: 'status_change',
      channel: 'sem',
      semDimension: changeDimension as NonNullable<ChangeRecord['semDimension']>,
      createdAt: createdAt.toISOString(),
      learningUntil,
      summary: changeSummary.trim(),
    };
    await saveChangeRecord(record);
    setChangeRecords((current) => [record, ...current]);
    setChangeSummary('');
    setError('');
  };
  const downloadProjectJson = async () => {
    if (!project) return;
    const blob = new Blob([JSON.stringify(await buildProjectExport(project), null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `seo-sem-${new URL(project.origin).hostname}.json`; anchor.click(); URL.revokeObjectURL(url);
  };
  const copyProjectMarkdown = async () => {
    if (!project) return;
    await navigator.clipboard.writeText(await projectExportMarkdown(project));
  };
  const removeCurrentProject = async () => {
    if (!project || !window.confirm(`删除项目“${project.name}”及其站点、CSV 和诊断数据？此操作无法恢复。`)) return;
    await Promise.all([deleteProject(project.id), clearAiConversation(project.origin, project.id)]); await refresh('');
  };
  const removeCurrentProjectConversation = async () => {
    if (!project || !window.confirm(`清除项目“${project.name}”的 AI 对话？此操作无法恢复。`)) return;
    await clearAiConversation(project.origin, project.id);
  };
  const clearEverything = async () => {
    if (!window.confirm('删除所有搜索项目和规范化数据？AI 配置与对话需在设置中单独清除。')) return;
    await clearAllProjectData(); await refresh('');
  };
  const handleSectionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentSection: Section) => {
    const currentIndex = SEM_SECTIONS.findIndex(([id]) => id === currentSection);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % SEM_SECTIONS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + SEM_SECTIONS.length) % SEM_SECTIONS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = SEM_SECTIONS.length - 1;
    else return;
    event.preventDefault();
    const nextSection = SEM_SECTIONS[nextIndex]![0];
    setSection(nextSection);
    document.getElementById(`sem-tab-${nextSection}`)?.focus();
  };
  return (
    <div className="sem-workspace view-stack">
      <section className="sem-project-bar">
        <div><p className="section-kicker">搜索广告效果检查</p><h2>SEM 诊断</h2><p>SEM 就是付费搜索广告。这里帮你核对广告花费、搜索词、落地页和真实业务结果；不会连接或修改广告账户。</p></div>
        <div className="project-controls">
          <SelectField label="分析项目" value={projectId} onChange={setProjectId} options={[{ value: '', label: '尚未创建' }, ...projects.map((item) => ({ value: item.id, label: item.name, description: item.origin }))]} />
          <button type="button" className="secondary-button" aria-label="新建项目" onClick={() => setCreateDialogOpen(true)}><Settings2 size={17} />新建分析项目</button>
        </div>
      </section>
      <div className="sem-segments" role="tablist" aria-label="SEM 工作区">
        {SEM_SECTIONS.map(([id, label, Icon]) => <button type="button" id={`sem-tab-${id}`} role="tab" aria-selected={section === id} aria-controls={`sem-panel-${id}`} tabIndex={section === id ? 0 : -1} className={section === id ? 'active' : ''} onClick={() => setSection(id)} onKeyDown={(event) => handleSectionKeyDown(event, id)} key={id}><Icon size={16} />{label}</button>)}
      </div>
      {SEM_SECTIONS.filter(([id]) => id !== section).map(([id]) => <div id={`sem-panel-${id}`} role="tabpanel" aria-labelledby={`sem-tab-${id}`} hidden key={`hidden-${id}`} />)}
      {error ? <div className="inline-alert" role="alert"><AlertCircle size={16} />{error}</div> : null}
      {notice ? <div className="notice success-notice" role="status"><Check size={16} />{notice}</div> : null}
      {!project ? <section id={`sem-panel-${section}`} role="tabpanel" aria-labelledby={`sem-tab-${section}`} className="sem-empty sem-section-panel"><Megaphone size={28} /><h3>先告诉插件要分析哪个网站</h3><p>“分析项目”只是把同一个网站的广告报表、业务结果和页面检查放在一起，不会连接广告账户。</p><button type="button" className="primary-button" onClick={() => setCreateDialogOpen(true)}>新建项目</button></section> : null}
      <ProjectCreateDialog
        open={createDialogOpen}
        title="新建 SEM 分析项目"
        description="输入广告落地页所属的网站。项目只用于归集这个网站的广告报表、页面检查和业务结果，不会连接广告账户。"
        initialValue={report?.url ? new URL(report.url).origin : ''}
        submitLabel="创建并选中"
        onClose={() => setCreateDialogOpen(false)}
        onSubmit={createProject}
      />
      {project && section === 'summary' ? (
        <div id="sem-panel-summary" role="tabpanel" aria-labelledby="sem-tab-summary" className="sem-section-panel">
          <section className="sem-what-is" aria-labelledby="sem-what-is-title">
            <div className="sticker-icon" aria-hidden="true"><Megaphone size={19} /></div>
            <div><h2 id="sem-what-is-title">这一页到底帮你判断什么？</h2><p>不是给广告账户打一个分，而是把“花了多少钱 → 带来哪些点击和转化 → 这些转化有没有业务价值”串起来。先导入广告表现，再按需补充业务结果，最后查看诊断。</p></div>
          </section>
          <section className="sem-onboarding" aria-labelledby="sem-onboarding-title">
            <div><p className="section-kicker">三步开始</p><h2 id="sem-onboarding-title">按顺序做，不容易迷路</h2><p>第一步告诉插件什么叫“有效”，第二步提供广告平台导出的数据，第三步才判断哪里值得复核。缺数据时只显示事实，不会假装给出调价结论。</p></div>
            <ol>{onboardingSteps.map((step, index) => <li className={step.complete ? 'complete' : ''} key={step.label}><button type="button" onClick={step.action}><span>{step.complete ? <Check size={16} /> : <Circle size={16} />}</span><span>步骤 {index + 1}<span>{step.label}</span></span></button></li>)}</ol>
          </section>
          <section className="sem-status-grid" aria-label="SEM 诊断状态">
            {([
              ['tracking', '数据能否信任'], ['searchTerms', '搜索词是否相关'], ['creativeLanding', '广告与页面是否一致'], ['conversionQuality', '转化是否有效'], ['commercialSustainability', '是否值得继续投放'],
            ] as const).map(([key, label]) => {
              const state = diagnosis?.statuses[key] ?? 'insufficient';
              return <div className={`sem-status status-${state}`} key={key}><span>{label}</span><p>{STATUS_LABELS[state]}</p><small>{STATUS_EXPLANATIONS[key]}</small></div>;
            })}
          </section>
          <section id="sem-basics" className="plain-section project-settings">
            <div className="section-heading"><div><p className="section-kicker">第 1 步</p><h2>先定义“有效”和“划算”</h2><p className="heading-help">至少填写一种真正想要的结果，再从 CPA、ROAS 或毛利中选一个你能确定的成本标准。输入后会自动保存在本机。</p></div></div>
            <div className="project-form-grid sem-core-form">
              <SelectField label="业务类型" value={project.sem.businessType} onChange={(value) => void updateProject({ sem: { ...project.sem, businessType: value as SearchProject['sem']['businessType'] } })} options={[{ value: 'lead_generation', label: '服务获客' }, { value: 'ecommerce', label: '电商' }, { value: 'saas', label: 'SaaS' }, { value: 'content', label: '内容业务' }, { value: 'other', label: '其他' }]} />
              <label><span>真正想要的结果（核心转化）</span><small>例如：有效表单、已付款订单</small><input aria-label="核心转化" value={project.primaryConversion} placeholder="例如：有效表单" onChange={(event) => void updateProject({ primaryConversion: event.target.value })} /></label>
              <label><span>报表使用的货币</span><small>例如：CNY、USD</small><input aria-label="货币" value={project.currency} maxLength={3} onChange={(event) => void updateProject({ currency: event.target.value.toUpperCase() })} /></label>
            </div>
            <div className="sem-cost-boundary">
              <div><h3>什么情况才算划算？</h3><p>下面三项不必全部填写，选择你做生意时真正会用的一项即可。</p></div>
              <div className="project-form-grid">
                <label><span>获得一个有效结果最多花多少（目标 CPA）</span><small>适合服务获客：广告成本 ÷ 有效线索或订单数</small><input aria-label="目标 CPA" type="number" min="0" placeholder="例如：100" value={project.sem.targetCpa ?? ''} onChange={(event) => void updateProject({ sem: { ...project.sem, targetCpa: event.target.value ? Number(event.target.value) : null } })} /></label>
                <label><span>每花 1 元希望带回多少收入（目标 ROAS）</span><small>例如填 3，表示花 1 元至少带回 3 元收入</small><input aria-label="目标 ROAS" type="number" min="0" step="0.1" placeholder="例如：3" value={project.sem.targetRoas ?? ''} onChange={(event) => void updateProject({ sem: { ...project.sem, targetRoas: event.target.value ? Number(event.target.value) : null } })} /></label>
                <label><span>每个有效结果能留下多少毛利</span><small>不是销售额，而是扣除商品或服务成本后的金额</small><input aria-label="单次毛利" type="number" min="0" placeholder="例如：300" value={project.sem.grossProfitPerConversion ?? ''} onChange={(event) => void updateProject({ sem: { ...project.sem, grossProfitPerConversion: event.target.value ? Number(event.target.value) : null } })} /></label>
              </div>
            </div>
            <details className="sem-advanced-settings">
              <summary><Settings2 size={17} />高级设置：品牌词、市场和项目管理</summary>
              <div className="project-form-grid">
                <label><span>项目名称</span><input value={project.name} onChange={(event) => void updateProject({ name: event.target.value })} /></label>
                <label><span>主域名</span><input value={project.origin} readOnly /></label>
                <label><span>市场</span><input value={project.market} onChange={(event) => void updateProject({ market: event.target.value })} /></label>
                <label><span>时区</span><input value={project.timezone} onChange={(event) => void updateProject({ timezone: event.target.value })} /></label>
                <label><span>品牌词</span><small>用于拆开已有品牌需求和新客户流量</small><input aria-label="品牌词" value={project.brandTerms.join(', ')} placeholder="逗号分隔" onChange={(event) => void updateProject({ brandTerms: event.target.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean) })} /></label>
                <label><span>已知不相关词</span><small>仅生成复核清单，不会自动否定</small><input value={project.sem.negativeTerms.join(', ')} placeholder="逗号分隔" onChange={(event) => void updateProject({ sem: { ...project.sem, negativeTerms: event.target.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean) } })} /></label>
              </div>
              <div className="project-data-actions">
                <button type="button" className="secondary-button" onClick={() => void copyProjectMarkdown()}>复制项目 Markdown</button>
                <button type="button" className="secondary-button" onClick={() => void downloadProjectJson()}>导出项目 JSON</button>
                <button type="button" className="text-button destructive-action" onClick={() => void removeCurrentProjectConversation()}><Trash2 size={16} />清除当前项目对话</button>
                <button type="button" className="text-button destructive-action" onClick={() => void removeCurrentProject()}><Trash2 size={16} />删除当前项目</button>
                <button type="button" className="text-button destructive-action" onClick={() => void clearEverything()}><Trash2 size={16} />清除全部搜索项目</button>
              </div>
            </details>
            <details className="sem-change-log">
              <summary><CalendarClock size={17} />高级：记录一次广告改动，避免误判效果</summary>
              <div className="sem-change-form">
                <p>这不是必填项。只有你确实改过预算、出价、转化目标或落地页，才需要记录；同一时期改太多东西，就无法知道哪一项造成变化。</p>
                <div>
                  <SelectField label="本次变更" value={changeDimension} onChange={setChangeDimension} options={[{ value: 'budget', label: '预算' }, { value: 'bid_strategy', label: '出价策略' }, { value: 'conversion_goal', label: '转化目标' }, { value: 'landing_page', label: '落地页' }, { value: 'creative', label: '广告创意' }, { value: 'targeting', label: '地域、时段或受众' }, { value: 'other', label: '其他单项变更' }]} />
                  <label><span>具体改动</span><input value={changeSummary} placeholder="例如：品牌搜索系列日预算从 100 调到 120" onChange={(event) => setChangeSummary(event.target.value)} /></label>
                  <label><span>观察天数</span><input type="number" min="1" max="90" inputMode="numeric" value={learningDays} onChange={(event) => setLearningDays(event.target.value)} /></label>
                  <button type="button" className="secondary-button" onClick={() => void recordSemChange()}><Plus size={16} />添加记录</button>
                </div>
                {changeRecords.length ? <div className="sem-change-history" aria-label="SEM 变更记录">{changeRecords.slice(0, 8).map((record) => <p key={record.id}><span>{record.semDimension === 'budget' ? '预算' : record.semDimension === 'bid_strategy' ? '出价' : record.semDimension === 'conversion_goal' ? '转化目标' : record.semDimension === 'landing_page' ? '落地页' : record.semDimension === 'creative' ? '创意' : record.semDimension === 'targeting' ? '定向' : '其他'}</span>{record.summary}<small>观察至 {record.learningUntil?.slice(0, 10) || '未设置'}</small></p>)}</div> : <p className="empty-copy">还没有变更记录。只有实际修改广告设置后才需要添加。</p>}
              </div>
            </details>
          </section>
        </div>
      ) : null}
      {project && section === 'landing' ? (
        <section id="sem-panel-landing" role="tabpanel" aria-labelledby="sem-tab-landing" className="plain-section sem-section-panel"><div className="section-heading"><div><p className="section-kicker">广告点击后的第一站</p><h2>页面有没有接住广告用户？</h2><p className="heading-help">广告带来点击只是第一步。这里检查用户搜索的需求、广告承诺和页面内容是否连贯，以及转化入口和追踪参数是否可见。</p></div><MousePointerClick size={18} /></div>
          <div className="project-form-grid landing-context-fields">
            <label><span>用户搜索什么（SEM 目标查询）</span><small>例如：企业 SEO 审计</small><input aria-label="SEM 目标查询" value={project.sem.landingTargetQuery ?? ''} placeholder="填写一个主要搜索需求" onChange={(event) => void updateProject({ sem: { ...project.sem, landingTargetQuery: event.target.value } })} /></label>
            <label><span>广告承诺了什么</span><small>例如：24 小时给出诊断报告</small><input aria-label="广告承诺" value={project.sem.adPromise ?? ''} placeholder="填写广告中最重要的承诺" onChange={(event) => void updateProject({ sem: { ...project.sem, adPromise: event.target.value } })} /></label>
          </div>
          {!report ? <p className="empty-copy">没有当前页面报告。先打开落地页并扫描，CSV 和诊断仍可继续使用。</p> : <div className="landing-check-list">{checks.map((item) => <div className={`landing-check status-${item.state}`} key={item.label}><span>{item.label}</span><p>{item.evidence}</p></div>)}</div>}
          <p className="section-note">这里能检查页面和 URL 上的线索，但不能仅凭 DOM 证明转化事件真的上报。事件是否触发，要再用广告平台调试工具或转化日志确认。</p>
        </section>
      ) : null}
      {project && section === 'data' ? (
        <div id="sem-panel-data" role="tabpanel" aria-labelledby="sem-tab-data" className="sem-section-panel">
          <section className="sem-data-intro"><div className="sticker-icon" aria-hidden="true"><FileSpreadsheet size={19} /></div><div><h2>把广告平台的报表放进来</h2><p>最少导入一份“广告表现” CSV，才能看展示、点击、成本和平台转化。再导入“业务结果”才能判断哪些线索真的有效；“创意数据”用于核对广告文案和落地页。</p><p className="section-note">原始文件只在本地解析，不上传；插件只保存你确认导入的规范字段。</p></div></section>
          <div className="importer-grid"><CsvImporter kind="sem_performance" project={project} onImported={handleDatasetImported} /><CsvImporter kind="sem_creative" project={project} onImported={handleDatasetImported} /><CsvImporter kind="business_outcome" project={project} onImported={handleDatasetImported} /></div>
          <section className="plain-section"><div className="section-heading"><div><p className="section-kicker">本地数据</p><h2>已导入数据集</h2></div></div>
            {semDatasets.length ? <div className="dataset-list">{semDatasets.map((dataset) => <div className="dataset-row" key={dataset.id}><div><span>{dataset.name}</span><p>{dataset.kind} · {dataset.platform} · {dataset.rowCount.toLocaleString()} 行</p></div><button type="button" className="icon-button" aria-label={`删除 ${dataset.name}`} title={`删除 ${dataset.name}`} onClick={() => void deleteDataset(dataset).then(() => refresh(project.id))}><Trash2 size={17} /></button></div>)}</div> : <p className="empty-copy">还没有 SEM 数据。原始文件不会保存，只保留映射后的规范字段。</p>}
          </section>
          <button type="button" className="primary-button sem-run" aria-label="运行 SEM 诊断" onClick={() => void runDiagnosis()}><Search size={17} />根据已导入数据生成诊断</button>
        </div>
      ) : null}
      {project && section === 'diagnosis' ? (
        <div id="sem-panel-diagnosis" role="tabpanel" aria-labelledby="sem-tab-diagnosis" className="sem-section-panel">{!diagnosis ? <section className="sem-empty"><BarChart3 size={28} /><h3>还没有可分析的结果</h3><p>先到“数据”导入广告表现 CSV，再点击“根据已导入数据生成诊断”。</p><button type="button" className="primary-button" onClick={() => setSection('data')}>去导入数据</button></section> : <>
          <section className="sem-diagnosis-intro"><h2>先看事实，再决定动作</h2><p>这些指标不是广告平台的总评分。它们分别回答：点击是否划算、平台转化是否可信、真实业务是否赚钱。每个问题都包含证据、原因、建议和验证方法。</p></section>
          <section className="sem-metric-grid">{diagnosis.metrics.map((item) => <div className={`sem-metric status-${item.state}`} key={item.id}><span>{item.label}</span><p>{item.formattedValue}</p><small>{item.evidence}</small></div>)}</section>
          <section className="plain-section"><div className="section-heading"><div><p className="section-kicker">固定诊断顺序</p><h2>问题与动作</h2></div></div>
            <div className="sem-finding-list">{diagnosis.findings.map((item) => <article className={`sem-finding priority-${item.priority.toLocaleLowerCase()}`} key={item.id}><div className="sem-finding-title"><span>{item.priority}</span><h3>{item.title}</h3><small>{STAGE_LABELS[item.stage]} · {item.confidence === 'low' ? '低置信度' : item.confidence === 'medium' ? '中置信度' : '高置信度'}</small></div><p><span className="detail-label">证据</span>{item.evidence}</p><p><span className="detail-label">为什么</span>{item.why}</p><p><span className="detail-label">动作</span>{item.action}</p><p><span className="detail-label">验证</span>{item.verification}</p>{item.stopCandidate ? <div className="candidate-label">仅为复核/停止候选，不会自动添加否定词</div> : null}</article>)}</div>
            {diagnosis.dataGaps.length ? <div className="data-gap-list"><h3>数据缺口</h3>{diagnosis.dataGaps.map((gap) => <p key={gap}>{gap}</p>)}</div> : null}
          </section>
        </>}</div>
      ) : null}
    </div>
  );
}
