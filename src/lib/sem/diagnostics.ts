import type {
  BusinessOutcomeRow,
  EvidenceConfidence,
  SearchProject,
  SemDiagnosticFinding,
  SemDiagnosticMetric,
  SemDiagnosticReport,
  SemCreativeRow,
  SemPerformanceRow,
  ChangeRecord,
} from '../projects/types';

function divide(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function money(value: number | null, currency: string): string {
  if (value === null) return '数据不足';
  const normalizedCurrency = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalizedCurrency) || normalizedCurrency === 'UNK') {
    return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)}（币种未设置）`;
  }
  try {
    return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: normalizedCurrency, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)}（币种未设置）`;
  }
}

function percent(value: number | null): string {
  return value === null ? '数据不足' : `${(value * 100).toFixed(2)}%`;
}

function fixed(value: number | null): string {
  return value === null ? '数据不足' : value.toFixed(2);
}

function confidenceFor(clicks: number, conversions: number): EvidenceConfidence {
  if (clicks >= 100 && conversions >= 10) return 'high';
  if (clicks >= 30 && conversions >= 3) return 'medium';
  return 'low';
}

function metric(id: string, label: string, value: number | null, formattedValue: string, evidence: string): SemDiagnosticMetric {
  return { id, label, value, formattedValue, state: value === null ? 'insufficient' : 'good', evidence };
}

function dateBounds(rows: SemPerformanceRow[]): { start: string | null; end: string | null; previousStart: string | null; previousEnd: string | null } {
  const dates = rows.map((row) => row.date).filter(Boolean).sort();
  if (!dates.length) return { start: null, end: null, previousStart: null, previousEnd: null };
  const start = new Date(`${dates[0]}T00:00:00Z`);
  const end = new Date(`${dates.at(-1)}T00:00:00Z`);
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
  const previousEnd = new Date(start.getTime() - 86_400_000);
  const previousStart = new Date(previousEnd.getTime() - (days - 1) * 86_400_000);
  return {
    start: dates[0]!,
    end: dates.at(-1)!,
    previousStart: previousStart.toISOString().slice(0, 10),
    previousEnd: previousEnd.toISOString().slice(0, 10),
  };
}

function finding(input: Omit<SemDiagnosticFinding, 'id'>): SemDiagnosticFinding {
  return { id: crypto.randomUUID(), ...input };
}

export function linkBusinessOutcomes(performanceRows: SemPerformanceRow[], businessRows: BusinessOutcomeRow[]): {
  linked: number;
  total: number;
  confidence: EvidenceConfidence;
  byPerformanceRow: Map<string, BusinessOutcomeRow[]>;
} {
  const byClickId = new Map(performanceRows.filter((row) => row.clickId).map((row) => [row.clickId!, row]));
  const byUtm = new Map<string, SemPerformanceRow[]>();
  const byCampaign = new Map<string, SemPerformanceRow[]>();
  for (const row of performanceRows) {
    if (row.utmCampaign) byUtm.set(row.utmCampaign.toLocaleLowerCase(), [...(byUtm.get(row.utmCampaign.toLocaleLowerCase()) || []), row]);
    if (row.campaign) byCampaign.set(row.campaign.toLocaleLowerCase(), [...(byCampaign.get(row.campaign.toLocaleLowerCase()) || []), row]);
  }
  const byPerformanceRow = new Map<string, BusinessOutcomeRow[]>();
  let linked = 0;
  let exact = 0;
  for (const business of businessRows) {
    let match: SemPerformanceRow | undefined;
    let confidence: EvidenceConfidence = 'low';
    if (business.clickId && byClickId.has(business.clickId)) { match = byClickId.get(business.clickId); confidence = 'high'; }
    if (!match && business.utmCampaign) {
      const candidates = byUtm.get(business.utmCampaign.toLocaleLowerCase()) || [];
      if (candidates.length === 1) { match = candidates[0]; confidence = 'medium'; }
    }
    if (!match && business.attributionKey) {
      const candidates = byCampaign.get(business.attributionKey.toLocaleLowerCase()) || [];
      if (candidates.length === 1) { match = candidates[0]; confidence = 'low'; }
    }
    if (!match) continue;
    linked += 1;
    if (confidence === 'high') exact += 1;
    business.attributionConfidence = confidence;
    byPerformanceRow.set(match.id, [...(byPerformanceRow.get(match.id) || []), business]);
  }
  const confidence: EvidenceConfidence = !businessRows.length || !linked ? 'low' : exact / linked >= 0.8 && linked >= 5 ? 'high' : linked / businessRows.length >= 0.5 ? 'medium' : 'low';
  return { linked, total: businessRows.length, confidence, byPerformanceRow };
}

export function diagnoseSem(
  project: SearchProject,
  performanceRows: SemPerformanceRow[],
  businessRows: BusinessOutcomeRow[],
  creativeRows: SemCreativeRow[] = [],
  changeRecords: ChangeRecord[] = [],
): SemDiagnosticReport {
  const impressions = performanceRows.reduce((sum, row) => sum + row.impressions, 0);
  const clicks = performanceRows.reduce((sum, row) => sum + row.clicks, 0);
  const cost = performanceRows.reduce((sum, row) => sum + row.cost, 0);
  const platformConversions = performanceRows.reduce((sum, row) => sum + row.platformConversions, 0);
  const platformValue = performanceRows.reduce((sum, row) => sum + row.conversionValue, 0);
  const validConversions = businessRows.reduce((sum, row) => sum + row.validConversions, 0);
  const revenue = businessRows.reduce((sum, row) => sum + row.revenue, 0);
  const refunds = businessRows.reduce((sum, row) => sum + row.refunds, 0);
  const grossProfit = businessRows.reduce((sum, row) => sum + row.grossProfit, 0);
  const netRevenue = Math.max(0, revenue - refunds);
  const ctr = divide(clicks, impressions);
  const cpc = divide(cost, clicks);
  const platformCpa = divide(cost, platformConversions);
  const validCpa = businessRows.length ? divide(cost, validConversions) : null;
  const refundAdjustedRoas = businessRows.length ? divide(netRevenue, cost) : null;
  const platformValueRoas = divide(platformValue, cost);
  const grossProfitReturn = businessRows.length && grossProfit ? divide(grossProfit, cost) : null;
  const sampleConfidence = confidenceFor(clicks, Math.max(platformConversions, validConversions));
  const findings: SemDiagnosticFinding[] = [];
  const dataGaps: string[] = [];
  if (!/^[A-Z]{3}$/.test(project.currency.trim().toUpperCase())) {
    dataGaps.push('项目币种尚未设置，金额按原始数值展示，不能与其他币种合并比较。');
  }
  const periodComparison = compareEqualPeriods(performanceRows);
  const attribution = linkBusinessOutcomes(performanceRows, businessRows);
  const now = Date.now();
  const activeChanges = changeRecords.filter((record) => record.channel === 'sem' && record.learningUntil && Date.parse(record.learningUntil) > now);
  const activeDimensions = [...new Set(activeChanges.map((record) => record.semDimension).filter(Boolean))];

  if (activeChanges.length) {
    const latestLearningEnd = activeChanges.map((record) => record.learningUntil!).sort().at(-1)!;
    findings.push(finding({
      stage: 'business',
      title: activeDimensions.length > 1 ? '多项广告变更仍处于重叠观察期' : '广告变更仍处于观察期',
      priority: activeDimensions.length > 1 ? 'P2' : 'P3',
      confidence: 'high',
      evidence: `${activeChanges.length} 条变更记录尚未结束观察，最晚到 ${latestLearningEnd.slice(0, 10)}。`,
      why: activeDimensions.length > 1 ? '预算、出价、转化目标或落地页同时变化时，结果无法可靠归因到其中一项。' : '自动出价和延迟转化需要积累成熟样本，过早判断容易把短期波动当成真实趋势。',
      action: activeDimensions.length > 1 ? '暂停叠加新的核心变量，把每个维度拆成独立实验；本期结果只记录事实，不宣称单项带来改善。' : '保持其他核心变量稳定，等待观察期结束后再用等长成熟周期比较有效 CPA、收入和毛利。',
      verification: `观察到 ${latestLearningEnd.slice(0, 10)} 后，排除未成熟转化，再与变更前等长周期比较。`,
      stopCandidate: false,
    }));
  }

  if (!performanceRows.length) {
    dataGaps.push('缺少广告表现 CSV，无法分析搜索词、成本和平台转化。');
  }
  if (!businessRows.length) {
    dataGaps.push('缺少业务结果 CSV，平台转化无法与有效线索、收入或退款核对。');
    findings.push(finding({
      stage: 'tracking',
      title: '平台转化尚未与真实业务结果核对',
      priority: 'P1',
      confidence: 'high',
      evidence: `平台报告 ${platformConversions.toFixed(2)} 次转化，但没有有效线索或订单结果。`,
      why: '平台转化增加不等于收入增加，重复事件、低质表单和品牌词蚕食都可能制造虚假增长。',
      action: '导入去重后的业务结果，至少包含日期、有效转化，并尽量补充收入、退款和毛利。',
      verification: '对比平台转化、有效转化、有效 CPA 和退款后 ROAS。',
      stopCandidate: false,
    }));
  } else if (platformConversions > 0 && validConversions / platformConversions < 0.5) {
    findings.push(finding({
      stage: 'tracking',
      title: '平台转化与有效业务差距较大',
      priority: 'P1',
      confidence: sampleConfidence,
      evidence: `平台转化 ${platformConversions.toFixed(2)}，有效转化 ${validConversions.toFixed(2)}。`,
      why: '自动出价可能正在优化容易触发但商业价值低的事件。',
      action: '检查事件去重、表单有效性和离线转化回传，把主要转化限定为能代表业务结果的事件。',
      verification: '观察平台转化与有效转化的差距是否连续两个完整周期缩小。',
      stopCandidate: false,
    }));
  }
  if (businessRows.length && attribution.linked === 0) {
    dataGaps.push('业务结果没有可匹配的点击 ID、UTM 系列或确认归因键，无法把收入可靠关联到系列、搜索词和落地页。');
  } else if (attribution.linked > 0 && attribution.linked < businessRows.length) {
    dataGaps.push(`只有 ${attribution.linked}/${businessRows.length} 条业务结果可关联到广告数据，细分结论为${attribution.confidence === 'high' ? '高' : attribution.confidence === 'medium' ? '中' : '低'}置信度。`);
  }
  const primaryRows = performanceRows.filter((row) => row.conversionType === 'primary');
  const observationRows = performanceRows.filter((row) => row.conversionType === 'observation');
  if (!performanceRows.some((row) => row.conversionType && row.conversionType !== 'unknown')) {
    dataGaps.push('缺少“主要/观察转化”字段，不能确认自动出价是否优化到真正的核心转化。');
  } else if (!primaryRows.length && observationRows.length) {
    findings.push(finding({
      stage: 'tracking', title: '导入数据没有可识别的主要转化', priority: 'P1', confidence: 'high',
      evidence: `${observationRows.length} 行标记为观察转化，没有主要转化行。`,
      why: '自动出价如果只看到观察事件，可能把容易触发的中间动作当成业务目标。',
      action: '在广告平台核对主要转化设置，并保留业务结果回传；不要在未验证事件去重前直接切换自动出价。',
      verification: '下一次导出应能区分主要与观察转化，并与有效线索或订单对齐。', stopCandidate: false,
    }));
  }

  const searchRows = performanceRows.filter((row) => row.searchTerm.trim());
  if (!searchRows.length && performanceRows.length) {
    dataGaps.push('广告数据没有搜索词字段，无法判断匹配扩张和否定词候选。');
  }
  const zeroConversionCandidates = searchRows
    .filter((row) => row.cost > 0 && row.platformConversions === 0)
    .sort((left, right) => right.cost - left.cost);
  const highSpendThreshold = project.sem.targetCpa ?? (platformCpa ? platformCpa * 1.5 : cost * 0.05);
  const highSpendZero = zeroConversionCandidates.filter((row) => row.cost >= Math.max(highSpendThreshold, 0.01));
  if (highSpendZero.length) {
    findings.push(finding({
      stage: 'search_terms',
      title: '存在零转化高消耗搜索词候选',
      priority: 'P2',
      confidence: sampleConfidence,
      evidence: `${highSpendZero.length} 个搜索词消耗超过复核阈值，合计 ${money(highSpendZero.reduce((sum, row) => sum + row.cost, 0), project.currency)}。`,
      why: '搜索词可能与业务意图不符，也可能只是转化延迟或样本不足。',
      action: '逐条核对意图、落地页和延迟转化，标记为复核或暂停候选；不要自动加入否定词。',
      verification: '在等长周期内观察其有效转化、收入和辅助转化后再决定。',
      stopCandidate: true,
    }));
  }
  const broadRows = searchRows.filter((row) => /broad|广泛|智能/i.test(row.matchType));
  const broadCost = broadRows.reduce((sum, row) => sum + row.cost, 0);
  if (broadRows.length && cost > 0 && broadCost / cost >= 0.4) findings.push(finding({
    stage: 'search_terms', title: '广泛或智能匹配占据较多成本', priority: 'P2', confidence: sampleConfidence,
    evidence: `${broadRows.length} 行广泛/智能匹配使用 ${percent(broadCost / cost)} 的成本。`,
    why: '匹配扩张可能带来新增需求，也可能把预算推向不相关搜索词，不能只看关键词本身。',
    action: '抽查实际搜索词、品牌/非品牌和有效转化，整理否定词复核清单；不自动否词，不在同一周期同时大改预算和出价。',
    verification: '比较等长周期内搜索词相关性、有效 CPA 和新增有效需求占比。', stopCandidate: false,
  }));

  const brandedCost = performanceRows.filter((row) => row.branded).reduce((sum, row) => sum + row.cost, 0);
  if (cost > 0 && brandedCost / cost > 0.5) {
    findings.push(finding({
      stage: 'cost',
      title: '品牌流量占广告成本较高',
      priority: 'P2',
      confidence: 'medium',
      evidence: `品牌词成本占总成本 ${percent(brandedCost / cost)}。`,
      why: '品牌搜索可能包含原本会自然到站的流量，平台 ROAS 不等于广告增量。',
      action: '将品牌与非品牌拆分预算和报告，设计地域或时间增量实验。',
      verification: '比较停投或降投实验中的总转化、自然品牌点击和增量成本。',
      stopCandidate: false,
    }));
  }

  const delayedRows = businessRows.filter((row) => (row.conversionDelayDays ?? 0) > 0);
  if (delayedRows.length) {
    const averageDelay = delayedRows.reduce((sum, row) => sum + (row.conversionDelayDays || 0), 0) / delayedRows.length;
    if (averageDelay >= 3) findings.push(finding({
      stage: 'business', title: '有效转化存在明显延迟', priority: 'P2', confidence: attribution.confidence,
      evidence: `${delayedRows.length} 条业务结果的平均转化延迟约 ${averageDelay.toFixed(1)} 天。`,
      why: '过早把最近几天标记为零转化，会误伤实际会延迟成交的搜索词和系列。',
      action: `停止候选至少等待 ${Math.ceil(averageDelay)} 天并结合归因窗口复核，不按当天平台转化直接调价。`,
      verification: '比较成熟窗口与未成熟窗口的有效 CPA 和收入回传完整度。', stopCandidate: false,
    }));
  }

  const periodTotals = (rows: SemPerformanceRow[]) => ({
    cost: rows.reduce((sum, row) => sum + row.cost, 0),
    conversions: rows.reduce((sum, row) => sum + row.platformConversions, 0),
  });
  const currentPeriod = periodTotals(periodComparison.current);
  const previousPeriod = periodTotals(periodComparison.previous);
  const costChange = previousPeriod.cost > 0 ? currentPeriod.cost / previousPeriod.cost - 1 : null;
  const conversionChange = previousPeriod.conversions > 0 ? currentPeriod.conversions / previousPeriod.conversions - 1 : null;
  if (costChange !== null && costChange >= 0.3 && (conversionChange === null || conversionChange < costChange * 0.5)) {
    findings.push(finding({
      stage: 'cost',
      title: '当前周期成本上涨快于平台转化',
      priority: 'P1',
      confidence: periodComparison.confidence,
      evidence: `与前一等长周期相比，成本变化 ${percent(costChange)}，平台转化变化 ${conversionChange === null ? '不可比' : percent(conversionChange)}。`,
      why: '成本上涨可能来自 CPC、匹配扩张、流量结构或转化追踪变化，不能直接归因于出价。',
      action: '按平台、品牌/非品牌、系列和搜索词拆分变化，先核对追踪，再逐层定位成本来源。',
      verification: '用下一等长周期比较有效转化、有效 CPA 与毛利，不只比较平台转化。',
      stopCandidate: false,
    }));
  }

  if (!performanceRows.some((row) => row.landingPage)) {
    dataGaps.push('缺少落地页字段，不能核对搜索意图、创意承诺和页面任务。');
  }
  const pmaxRows = performanceRows.filter((row) => /pmax|performance max|效果最大化/i.test(row.campaignType || ''));
  if (pmaxRows.length && !pmaxRows.some((row) => row.assetGroup)) dataGaps.push('检测到 PMax，但缺少素材组字段，无法核对素材组与落地页任务。');
  const aiMaxRows = performanceRows.filter((row) => /ai max/i.test(row.campaignType || '') || /ai max/i.test(row.bidStrategy || ''));
  if (aiMaxRows.length && !aiMaxRows.some((row) => row.finalUrlExpansion)) dataGaps.push('检测到 AI Max，但缺少最终网址扩展字段，无法判断流量是否被送到非预期页面。');
  const ocpcRows = performanceRows.filter((row) => row.platform === 'baidu' && /ocpc/i.test(row.bidStrategy || ''));
  if (ocpcRows.length && !businessRows.length) findings.push(finding({
    stage: 'tracking', title: '百度 oCPC 缺少真实业务结果校验', priority: 'P1', confidence: 'high',
    evidence: `${ocpcRows.length} 行使用 oCPC，但没有业务结果数据。`, why: 'oCPC 会依赖转化信号学习，低质或重复事件会放大无效流量。',
    action: '先核对转化事件去重、有效线索和回传延迟，再决定是否调整目标成本。', verification: '连续两个成熟周期比较平台转化、有效转化和有效 CPA。', stopCandidate: false,
  }));
  const expansionRisk = performanceRows.filter((row) => /enabled|开启|true|yes/i.test(row.finalUrlExpansion || '') && row.landingPage);
  if (expansionRisk.length) findings.push(finding({
    stage: 'creative_landing', title: '自动最终网址扩展需要复核', priority: 'P2', confidence: 'medium',
    evidence: `${expansionRisk.length} 行启用了最终网址扩展。`, why: '自动扩展可能找到更相关页面，也可能绕过为特定广告承诺设计的落地页。',
    action: '按搜索词和实际最终网址核对页面任务、转化与品牌安全，不要只看系列汇总。', verification: '导出实际最终网址并与指定落地页、有效转化做对照。', stopCandidate: false,
  }));
  if (!creativeRows.length) {
    dataGaps.push('缺少创意 CSV，不能核对广告标题、描述和最终网址的完整性。');
  } else {
    const incompleteCreatives = creativeRows.filter((row) => !row.headline.trim() || !row.description.trim() || !row.finalUrl.trim());
    const landingPagesByGroup = new Map<string, Set<string>>();
    for (const row of creativeRows) {
      if (!row.adGroup.trim() || !row.finalUrl.trim()) continue;
      const pages = landingPagesByGroup.get(row.adGroup) ?? new Set<string>();
      pages.add(row.finalUrl.trim());
      landingPagesByGroup.set(row.adGroup, pages);
    }
    const inconsistentGroups = [...landingPagesByGroup].filter(([, pages]) => pages.size > 1);
    if (incompleteCreatives.length || inconsistentGroups.length) {
      findings.push(finding({
        stage: 'creative_landing',
        title: '创意与落地页映射需要复核',
        priority: 'P2',
        confidence: 'high',
        evidence: `${incompleteCreatives.length} 条创意缺少标题、描述或最终网址；${inconsistentGroups.length} 个广告组对应多个落地页。`,
        why: '创意承诺不完整或同一广告组页面任务分散，会降低搜索词、广告和页面之间的一致性。',
        action: '按广告组核对搜索意图、标题、描述和最终网址；多个页面确有不同任务时拆分广告组。',
        verification: '重新导出创意数据，并抽样检查实际点击后的最终页面和主要转化。',
        stopCandidate: false,
      }));
    }
  }
  if (sampleConfidence === 'low' && performanceRows.length) {
    findings.push(finding({
      stage: 'business',
      title: '样本不足，结论仅供观察',
      priority: 'P3',
      confidence: 'high',
      evidence: `当前只有 ${clicks} 次点击、${Math.max(platformConversions, validConversions).toFixed(2)} 次转化。`,
      why: '少量转化的随机波动足以显著改变 CPA 和 ROAS。',
      action: '延长观察周期或合并同类广告组，不基于一两次转化做大幅调价。',
      verification: '达到约 30 次点击且至少 3 次有效转化后重新诊断。',
      stopCandidate: false,
    }));
  }

  if (project.sem.targetCpa === null) dataGaps.push('未设置目标 CPA，无法判断获得一个有效结果的成本是否超过你的可接受范围。');
  if (project.sem.targetRoas === null && project.sem.grossProfitPerConversion === null && !grossProfit) {
    dataGaps.push('未设置目标 ROAS、单次毛利或导入毛利，不能得出扩量或自动出价结论。');
  }
  if (project.sem.targetCpa !== null && validCpa !== null && validCpa > project.sem.targetCpa) {
    findings.push(finding({
      stage: 'budget',
      title: '有效 CPA 超过业务目标',
      priority: 'P1',
      confidence: sampleConfidence,
      evidence: `有效 CPA ${money(validCpa, project.currency)}，目标 ${money(project.sem.targetCpa, project.currency)}。`,
      why: '继续按平台转化扩量可能放大无效线索和亏损。',
      action: '先修复追踪与搜索词质量，再按边际有效 CPA 重分配预算，不直接提高总预算。',
      verification: '连续两个等长周期比较有效 CPA、有效量和毛利回报。',
      stopCandidate: false,
    }));
  }

  const metrics = [
    metric('ctr', 'CTR', ctr, percent(ctr), `${clicks} 次点击 / ${impressions} 次展示`),
    metric('cpc', '平均 CPC', cpc, money(cpc, project.currency), `${money(cost, project.currency)} / ${clicks} 次点击`),
    metric('platform-cpa', '平台 CPA', platformCpa, money(platformCpa, project.currency), `${platformConversions.toFixed(2)} 次平台转化`),
    metric('valid-cpa', '有效 CPA', validCpa, money(validCpa, project.currency), businessRows.length ? `${validConversions.toFixed(2)} 次有效转化` : '缺少业务结果'),
    metric('platform-value-roas', '平台价值 ROAS', platformValueRoas, fixed(platformValueRoas), '平台归因价值，仅作为中间指标'),
    metric('refund-roas', '退款后 ROAS', refundAdjustedRoas, fixed(refundAdjustedRoas), businessRows.length ? `净收入 ${money(netRevenue, project.currency)}` : '缺少收入与退款业务结果'),
    metric('profit-return', '毛利回报', grossProfitReturn, fixed(grossProfitReturn), grossProfit ? `毛利 ${money(grossProfit, project.currency)}` : '缺少毛利数据'),
    metric('period-cost-change', '等长周期成本变化', costChange, percent(costChange), periodComparison.previous.length ? `当前 ${money(currentPeriod.cost, project.currency)} / 前期 ${money(previousPeriod.cost, project.currency)}` : '没有可比较的前一周期'),
    metric('attribution-link-rate', '业务归因关联率', businessRows.length ? attribution.linked / businessRows.length : null, businessRows.length ? percent(attribution.linked / businessRows.length) : '数据不足', businessRows.length ? `${attribution.linked}/${businessRows.length} 条业务结果已关联，${attribution.confidence} 置信度` : '缺少业务结果'),
  ];

  return {
    id: crypto.randomUUID(),
    projectId: project.id,
    createdAt: new Date().toISOString(),
    period: dateBounds(performanceRows),
    statuses: {
      tracking: !performanceRows.length || !businessRows.length ? 'insufficient' : findings.some((item) => item.stage === 'tracking' && item.priority === 'P1') ? 'risk' : 'good',
      searchTerms: !searchRows.length ? 'insufficient' : highSpendZero.length ? 'attention' : 'good',
      creativeLanding: !creativeRows.length || !performanceRows.some((row) => row.landingPage) ? 'insufficient' : findings.some((item) => item.stage === 'creative_landing') ? 'attention' : 'good',
      conversionQuality: !businessRows.length ? 'insufficient' : platformConversions > 0 && validConversions / platformConversions < 0.5 ? 'risk' : 'good',
      commercialSustainability: project.sem.targetCpa === null && project.sem.targetRoas === null && !grossProfit ? 'insufficient' : findings.some((item) => item.stage === 'budget' && item.priority === 'P1') ? 'risk' : 'good',
    },
    metrics,
    findings,
    dataGaps,
    sampleConfidence,
  };
}

export function splitBrandPerformance(rows: SemPerformanceRow[]): {
  branded: SemPerformanceRow[];
  nonBranded: SemPerformanceRow[];
} {
  return { branded: rows.filter((row) => row.branded), nonBranded: rows.filter((row) => !row.branded) };
}

export function compareEqualPeriods(rows: SemPerformanceRow[]): {
  current: SemPerformanceRow[];
  previous: SemPerformanceRow[];
  confidence: EvidenceConfidence;
} {
  const dated = rows.filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date)).sort((a, b) => a.date.localeCompare(b.date));
  if (dated.length < 2) return { current: dated, previous: [], confidence: 'low' };
  const uniqueDates = [...new Set(dated.map((row) => row.date))];
  const periodDays = Math.floor(uniqueDates.length / 2);
  if (periodDays === 0) return { current: dated, previous: [], confidence: 'low' };
  const currentDates = new Set(uniqueDates.slice(-periodDays));
  const previousDates = new Set(uniqueDates.slice(-periodDays * 2, -periodDays));
  const previous = dated.filter((row) => previousDates.has(row.date));
  const current = dated.filter((row) => currentDates.has(row.date));
  const clicks = current.reduce((sum, row) => sum + row.clicks, 0) + previous.reduce((sum, row) => sum + row.clicks, 0);
  const conversions = current.reduce((sum, row) => sum + row.platformConversions, 0) + previous.reduce((sum, row) => sum + row.platformConversions, 0);
  return { current, previous, confidence: confidenceFor(clicks, conversions) };
}
