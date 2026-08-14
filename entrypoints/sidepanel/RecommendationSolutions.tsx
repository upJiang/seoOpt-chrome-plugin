import { ArrowRight, Check, ChevronDown, ChevronUp, Code2, Copy, MapPin } from 'lucide-react';
import { useLayoutEffect, useState } from 'react';

import type { AuditFinding } from '../../src/lib/audit/types';
import type { ImplementationRecipe, OptimizationRecommendation } from '../../src/lib/audit/recommendations';

export function ImplementationRecipeView({ recipe, compact = false }: { recipe: ImplementationRecipe; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const copyCode = async () => {
    if (!recipe.variant.code) return;
    await navigator.clipboard.writeText(recipe.variant.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return <div className={`code-advice${compact ? ' code-advice-compact' : ''}`}>
    <div className="code-advice-heading">
      <span><Code2 size={16} aria-hidden="true" />{recipe.title}</span>
      <span className="code-advice-type">{recipe.applicableTechnology}</span>
    </div>
    <p className="code-advice-location"><span>通常修改位置</span>{recipe.modificationLocation}</p>
    {recipe.variant.code ? <>
      <div className="code-advice-toolbar">
        <span>{recipe.variant.language}</span>
        <button type="button" className="code-copy-button" onClick={() => void copyCode()} aria-label={`复制${recipe.title}代码`}>
          {copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre><code>{recipe.variant.code}</code></pre>
    </> : <p className="code-advice-empty">不适合直接用代码修复</p>}
    <button type="button" className="recipe-detail-trigger" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((current) => !current)}>
      <span>查看代码解释、变量、验证和回滚</span>{detailsOpen ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
    </button>
    {detailsOpen ? <div className="recipe-details">
      <div><h4>修改前提</h4><ul>{recipe.prerequisites.map((item) => <li key={item}>{item}</li>)}</ul></div>
      {recipe.placeholders.length ? <div><h4>需要替换的内容</h4><dl>{recipe.placeholders.map((item) => <div key={item.token}><dt><code>{item.token}</code></dt><dd>{item.meaning}</dd></div>)}</dl></div> : <p className="recipe-no-placeholder">代码已使用当前页面地址或固定配置，没有隐藏的模板占位符。</p>}
      {recipe.lineExplanations.length ? <div><h4>代码逐段解释</h4><dl>{recipe.lineExplanations.map((item) => <div key={`${item.code}:${item.explanation}`}><dt><code>{item.code}</code></dt><dd>{item.explanation}</dd></div>)}</dl></div> : null}
      <div><h4>发布前检查</h4><ul>{recipe.prePublishChecks.map((item) => <li key={item}>{item}</li>)}</ul></div>
      <div><h4>如何验证代码正确</h4><ol>{recipe.verificationSteps.map((item) => <li key={item}>{item}</li>)}</ol></div>
      <div><h4>如何回滚</h4><p>{recipe.rollback}</p></div>
    </div> : null}
  </div>;
}

function recommendationStatus(item: OptimizationRecommendation): string {
  if (item.findings[0]?.status === 'warning') return item.confidence === 'high' ? '高置信度优化机会' : '条件性优化机会';
  if (item.priority === 'P0') return '已确认的阻断问题';
  if (item.priority === 'P1' && item.confidence === 'high') return '已确认的高影响问题';
  if (item.confidence === 'high') return '高置信度增长问题';
  return item.confidence === 'medium' ? '风险候选' : '需要更多证据确认';
}

export function RecommendationSolutions({
  recommendations,
  selectedRecommendationId,
  pageFindingIds,
  emptyMessage = '这只代表本次取得的页面证据没有发现对应问题，实际搜索结果仍需外部数据验证。',
  onLocate,
  onOpenIssue,
}: {
  recommendations: OptimizationRecommendation[];
  selectedRecommendationId?: string | null;
  pageFindingIds?: Set<string>;
  emptyMessage?: string;
  onLocate?: (finding: AuditFinding) => void;
  onOpenIssue?: (finding: AuditFinding) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(selectedRecommendationId ? [selectedRecommendationId] : []));
  useLayoutEffect(() => {
    if (!selectedRecommendationId || !recommendations.some((item) => item.rootCauseId === selectedRecommendationId)) return;
    setExpanded((current) => new Set(current).add(selectedRecommendationId));
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-recommendation-id="${CSS.escape(selectedRecommendationId)}"]`)?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
    return () => cancelAnimationFrame(frame);
  }, [recommendations, selectedRecommendationId]);

  if (!recommendations.length) return <section className="recommendation-empty" role="status">
    <Check size={26} aria-hidden="true" />
    <div><h2>当前分类没有优化建议</h2><p>{emptyMessage}</p></div>
  </section>;

  return <div className="recommendation-list">{recommendations.map((recommendation) => {
    const finding = recommendation.findings[0]!;
    const hasPageIssue = pageFindingIds?.has(finding.id) ?? false;
    const isExpanded = expanded.has(recommendation.rootCauseId);
    return <article className="recommendation-item recommendation-solution" key={recommendation.id} data-recommendation-id={recommendation.rootCauseId}>
      <button type="button" className="recommendation-summary" aria-expanded={isExpanded} onClick={() => setExpanded((current) => {
        const next = new Set(current);
        if (next.has(recommendation.rootCauseId)) next.delete(recommendation.rootCauseId); else next.add(recommendation.rootCauseId);
        return next;
      })}>
        <span className="recommendation-summary-copy">
          <span className="recommendation-meta"><span className={`priority-badge priority-${recommendation.priority.toLocaleLowerCase()}`}>{recommendation.priority}</span><span>{recommendationStatus(recommendation)}</span><span>{recommendation.scope === 'page' ? '当前页面证据' : '站点抽样证据'}</span></span>
          <span className="recommendation-title-text">{recommendation.title}</span>
          <span className="recommendation-preview">{recommendation.conclusion}</span>
        </span>
        {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
      </button>
      <div className="recommendation-core">
        {recommendation.findings.length > 1 ? <p className="root-cause-summary">同一根因合并 {recommendation.findings.length} 个问题；本次证据影响 {Math.max(1, recommendation.affectedUrls.length)} 个 URL。页面级证据与站点抽样不会混作全站结论。</p> : null}
        <div className="recommendation-strategy"><span>推荐策略 · {recommendation.strategy.modificationLayer}</span><p>{recommendation.strategy.summary}</p></div>
        {recommendation.implementationRecipes[0] ? <ImplementationRecipeView recipe={recommendation.implementationRecipes[0]} compact /> : null}
      </div>
      {isExpanded ? <div className="recommendation-expanded" id={`${recommendation.id}:details`}>
        <dl className="recommendation-detail">
          <div><dt>为什么会出现</dt><dd>{recommendation.seoMechanism}</dd></div>
          <div><dt>为什么值得优化</dt><dd>{recommendation.currentImpact}</dd></div>
          <div className="recommendation-outcome direct-result"><dt>修改后的直接结果</dt><dd>{recommendation.expectedDirectResult}</dd></div>
          <div className="recommendation-outcome search-effect"><dt>可能带来的搜索效果</dt><dd>{recommendation.possibleSearchEffect}</dd></div>
          <div className="recommendation-outcome no-guarantee"><dt>不能保证</dt><dd>{recommendation.notGuaranteed}</dd></div>
          <div><dt>可以解决哪些问题</dt><dd>{recommendation.strategy.resolves.join('、')}</dd></div>
          <div><dt>如何验证代码正确</dt><dd>{recommendation.verification.codeCorrectness.join('；')}</dd></div>
          <div><dt>搜索效果如何验证</dt><dd>{recommendation.verification.searchEffect.join('；')}</dd></div>
          <div><dt>不要这样修改</dt><dd>{recommendation.pitfalls.join('；')}</dd></div>
          <div><dt>适用范围与检测限制</dt><dd>{recommendation.limitations.join('；')}</dd></div>
        </dl>
        {recommendation.implementationRecipes.slice(1).map((recipe) => <ImplementationRecipeView recipe={recipe} compact key={recipe.id} />)}
        <details className="recommendation-evidence-list"><summary>查看全部检测证据</summary><ul>{recommendation.evidence.map((item) => <li key={item.findingId}><span>{item.confidence === 'high' ? '高' : item.confidence === 'medium' ? '中' : '低'}置信度 · {item.source}</span><p>{item.summary}</p></li>)}</ul></details>
        {onLocate || onOpenIssue ? <div className="recommendation-actions">
          {onLocate && finding.locator ? <button type="button" className="secondary-button" onClick={() => onLocate(finding)}><MapPin size={16} />网页定位</button> : null}
          {onOpenIssue && hasPageIssue ? <button type="button" className="text-button" onClick={() => onOpenIssue(finding)}>查看完整问题<ArrowRight size={16} /></button> : null}
        </div> : null}
      </div> : null}
    </article>;
  })}</div>;
}
