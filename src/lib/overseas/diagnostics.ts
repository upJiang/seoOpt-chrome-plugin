import type { PageSnapshot } from '../audit/types';
import type {
  AnalyticsPerformanceRow,
  AnalyticsTagSnapshot,
  BusinessOutcomeRow,
  ConsentSignalSnapshot,
  EvidenceConfidence,
  InternationalProjectSettings,
  InternationalSeoSnapshot,
  GoogleVerificationResult,
  OtherAnalyticsSnapshot,
  OverseasDiagnosis,
  OverseasSummary,
  OverseasDiagnosticFinding,
  OverseasSignalStatus,
  OverseasStaticSnapshot,
  SearchAccessConclusion,
  SemPerformanceRow,
  TrackingChainStage,
  TrackingObservation,
  TrackingReconciliationReport,
  TrackingTestRun,
  TrackingTestConclusion,
} from '../projects/types';

const TRACKING_PARAMETER_NAMES = ['gclid', 'gbraid', 'wbraid', 'msclkid', 'utm_source', 'utm_medium', 'utm_campaign'];
const SENSITIVE_NAME = /(?:email|e-mail|mail|phone|mobile|telephone|name|address|邮箱|电话|手机|姓名|地址)/i;
const CORE_EVENTS: Record<TrackingTestRun['goal'], string[]> = {
  lead: ['generate_lead', 'lead', 'form_submit'],
  signup: ['sign_up', 'signup', 'registration_complete'],
  trial: ['start_trial', 'trial_start'],
  purchase: ['purchase', 'order_complete'],
  download: ['file_download', 'download'],
  custom: [],
};
const TRACKING_PLATFORMS = new Set<TrackingObservation['platform']>(['google_analytics', 'google_tag_manager', 'google_ads', 'bing_uet', 'microsoft_clarity', 'browser']);
const TRACKING_TYPES = new Set<TrackingObservation['type']>(['initialization', 'request', 'event', 'route', 'consent']);
const TRACKING_QUERY_PARAMETER = /^(?:gclid|gbraid|wbraid|msclkid|utm_(?:source|medium|campaign|term|content))$/i;

export interface StaticAnalyticsInput {
  scriptUrls: string[];
  inlineScriptText: string[];
  resourceUrls: string[];
  dataLayerEntries: unknown[];
  uetEntries: unknown[];
  currentUrl: string;
  finalUrl: string;
}

function uniqueMatches(values: string[], pattern: RegExp): string[] {
  const found = values.flatMap((value) => [...value.matchAll(pattern)].map((match) => match[0].toUpperCase()));
  return [...new Set(found)];
}

function duplicateValues(values: string[]): string[] {
  const counts = new Map<string, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts].filter(([, count]) => count > 1).map(([value]) => value);
}

interface SafeCommandEntry {
  command: string;
  event: string;
  target: string;
  consentSignals: ConsentSignalSnapshot['signals'] | null;
}

function safeCommandEntries(entries: unknown[]): SafeCommandEntry[] {
  return entries.slice(-100).flatMap((entry) => {
    if (Array.isArray(entry)) {
      const command = typeof entry[0] === 'string' ? entry[0] : '';
      const target = typeof entry[1] === 'string' ? entry[1] : '';
      const event = command === 'event' ? target : '';
      const values = entry[2] && typeof entry[2] === 'object' ? entry[2] as Record<string, unknown> : {};
      const signalNames = ['analytics_storage', 'ad_storage', 'ad_user_data', 'ad_personalization'] as const;
      const consentSignals = command === 'consent'
        ? Object.fromEntries(signalNames.map((name) => [name, typeof values[name] === 'string' ? values[name]!.slice(0, 24) : null])) as ConsentSignalSnapshot['signals']
        : null;
      return [{ command, event, target, consentSignals }];
    }
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      return [{ command: '', event: typeof record.event === 'string' ? record.event.slice(0, 100) : '', target: '', consentSignals: null }];
    }
    return [];
  });
}

function tag(
  platform: AnalyticsTagSnapshot['platform'],
  ids: string[],
  scripts: string[],
  initialized: boolean,
  requestObserved: boolean,
  events: string[],
  options: { oldUa?: boolean; mixed?: boolean } = {},
): AnalyticsTagSnapshot {
  return {
    platform,
    ids: [...new Set(ids)],
    scriptCount: scripts.length,
    duplicateIds: duplicateValues(ids),
    initialized,
    requestObserved,
    events: [...new Set(events)].slice(0, 50),
    oldUniversalAnalytics: options.oldUa ?? false,
    hardcodedAndTagManagerCandidate: options.mixed ?? false,
  };
}

function consentSnapshot(commands: SafeCommandEntry[]): ConsentSignalSnapshot {
  const consentCommands = commands.filter((item) => item.command === 'consent');
  const defaults = consentCommands.findIndex((item) => item.target === 'default');
  const updates = consentCommands.findIndex((item) => item.target === 'update');
  const signals = consentCommands.reduce<ConsentSignalSnapshot['signals']>((current, item) => {
    if (!item.consentSignals) return current;
    return Object.fromEntries(Object.entries(current).map(([name, value]) => [name, item.consentSignals?.[name] ?? value]));
  }, {
    analytics_storage: null,
    ad_storage: null,
    ad_user_data: null,
    ad_personalization: null,
  });
  return {
    found: consentCommands.length > 0,
    defaultSeen: defaults >= 0,
    updateSeen: updates >= 0,
    orderValid: defaults < 0 || updates < 0 ? null : defaults < updates,
    signals,
    explanation: consentCommands.length
      ? defaults >= 0 ? '观察到 Consent Mode 命令；具体同意值仍需结合 CMP 和目标市场确认。' : '观察到 Consent 更新，但没有观察到默认状态。'
      : '本次页面现场未观察到 Google Consent Mode 命令；这不等同于法律不合规。',
  };
}

function dominantLanguage(text: string): { language: string | null; confidence: 'high' | 'medium' | 'low' } {
  const sample = text.slice(0, 4_000);
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  const han = (sample.match(/[\u3400-\u9fff]/g) ?? []).length;
  const japanese = (sample.match(/[\u3040-\u30ff]/g) ?? []).length;
  const korean = (sample.match(/[\uac00-\ud7af]/g) ?? []).length;
  const total = latin + han + japanese + korean;
  if (total < 80) return { language: null, confidence: 'low' };
  const candidates = [
    { language: 'en', count: latin },
    { language: japanese > 20 ? 'ja' : 'zh', count: han + japanese },
    { language: 'ko', count: korean },
  ].sort((left, right) => right.count - left.count);
  const ratio = candidates[0]!.count / total;
  return { language: candidates[0]!.language, confidence: ratio >= 0.8 ? 'high' : ratio >= 0.55 ? 'medium' : 'low' };
}

function baseLanguage(value: string): string {
  return value.trim().toLocaleLowerCase().split('-')[0] ?? '';
}

function isValidLanguageTag(value: string): boolean {
  try {
    if (!value.trim() || value.toLocaleLowerCase() === 'x-default') return false;
    new Intl.Locale(value.trim());
    return true;
  } catch {
    return false;
  }
}

export function buildInternationalSeo(snapshot: PageSnapshot, settings: InternationalProjectSettings): InternationalSeoSnapshot {
  const detected = dominantLanguage(snapshot.visibleTextPreview);
  const issues: string[] = [];
  const langValid = isValidLanguageTag(snapshot.htmlLang);
  if (!snapshot.htmlLang) issues.push('页面没有声明语言（html lang）。');
  else if (!langValid) issues.push(`页面语言代码“${snapshot.htmlLang}”格式无效。`);
  if (settings.targetLanguage && snapshot.htmlLang && baseLanguage(settings.targetLanguage) !== baseLanguage(snapshot.htmlLang)) {
    issues.push(`页面声明语言 ${snapshot.htmlLang} 与目标语言 ${settings.targetLanguage} 不一致。`);
  }
  if (detected.language && snapshot.htmlLang && detected.confidence !== 'low' && baseLanguage(snapshot.htmlLang) !== detected.language) {
    issues.push(`正文主要语言候选 ${detected.language} 与页面声明 ${snapshot.htmlLang} 不一致。`);
  }
  const current = new URL(snapshot.url);
  const selfReference = snapshot.hreflangs.length
    ? snapshot.hreflangs.some((item) => {
      try { return new URL(item.href, current).href === current.href; } catch { return false; }
    })
    : null;
  if (snapshot.hreflangs.some((item) => !item.valid)) issues.push('存在无效 hreflang 语言代码或地址。');
  if (snapshot.hreflangs.length > 1 && selfReference === false) issues.push('多语言页面缺少指向自身的 hreflang。');
  const status = issues.some((item) => /无效|不一致|缺少/.test(item)) ? 'attention' : 'normal';
  return {
    status,
    htmlLang: snapshot.htmlLang,
    detectedLanguage: detected.language,
    languageConfidence: detected.confidence,
    targetLanguage: settings.targetLanguage,
    hreflangCount: snapshot.hreflangs.length,
    selfReference,
    reciprocalCandidates: snapshot.hreflangs.filter((item) => item.valid).length,
    xDefault: snapshot.hreflangs.some((item) => item.lang.toLocaleLowerCase() === 'x-default'),
    issues,
    regionalSignals: {
      currencyCodes: [...new Set(snapshot.visibleTextPreview.match(/\b(?:USD|EUR|GBP|CAD|AUD|JPY|CNY|RMB|HKD|SGD)\b/gi) ?? [])].map((item) => item.toUpperCase()),
      phoneCountryCodes: [...new Set(snapshot.visibleTextPreview.match(/\+[1-9]\d{0,3}(?=[\s()-])/g) ?? [])],
      datePatterns: [...new Set([
        ...(snapshot.visibleTextPreview.match(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g) ?? []),
        ...(snapshot.visibleTextPreview.match(/\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b/g) ?? []),
      ])].slice(0, 10),
    },
    checkedAt: new Date().toISOString(),
  };
}

function samePageUrl(left: string, right: string): boolean {
  try {
    const normalize = (value: string) => {
      const url = new URL(value);
      url.hash = '';
      return url.href.replace(/\/$/, '');
    };
    return normalize(left) === normalize(right);
  } catch {
    return left === right;
  }
}

function searchAccessConclusion(snapshot: PageSnapshot): OverseasSummary['searchAccess'] {
  const pageProbe = snapshot.siteProbe.page;
  const browserUrl = snapshot.url;
  const finalUrl = pageProbe.finalUrl || browserUrl;
  const publicRequestFailed = pageProbe.status === null || Boolean(pageProbe.error);
  const publicRequestReturnedError = pageProbe.status !== null && pageProbe.status >= 400;
  const publicRequestChangedPage = Boolean(finalUrl) && !samePageUrl(browserUrl, finalUrl);
  const evidence = [
    `浏览器页面：${browserUrl}`,
    `公开请求状态：${pageProbe.status ?? '无法读取'}`,
    `公开请求最终地址：${finalUrl || '无法读取'}`,
    ...(pageProbe.error ? [`请求错误：${pageProbe.error}`] : []),
  ];

  if (publicRequestReturnedError || publicRequestChangedPage) {
    let hostname = '当前网站';
    try { hostname = new URL(browserUrl).hostname; } catch { /* Keep the safe fallback. */ }
    return {
      id: 'overseas:search:public-access-mismatch',
      status: 'attention',
      title: '公开访问可能返回了其他页面',
      explanation: '你在浏览器中可以打开网站，但插件不带登录信息进行公开访问时，得到的是错误页面或另一个地址。',
      checked: '比较了浏览器当前地址、公开请求最终地址和响应状态。',
      impact: 'Google 可能无法稳定读取当前页面，但插件不能仅凭这次请求断言 Googlebot 已被拦截。',
      action: '让开发人员检查 CDN、WAF、地区访问规则和跳转配置，再用 Search Console 测试实际网址。',
      expectedResult: '浏览器访问和不带登录信息的公开请求都返回正式页面、200 状态和相同主要内容。',
      owner: '需要网站开发处理',
      actionTarget: 'search_access',
      developerMessage: `请检查 ${hostname} 当前页面的 CDN、WAF 和地区访问规则。普通浏览器可以打开 ${browserUrl}，但不带登录信息的公开请求最终得到 ${finalUrl || '未知地址'}（状态 ${pageProbe.status ?? '未知'}）。请确认 Googlebot 和海外普通访问均返回正式页面、200 状态和相同主要内容。`,
      confidence: 'medium',
      technicalEvidence: evidence,
    };
  }

  if (publicRequestFailed) {
    return {
      id: 'overseas:search:public-access-unavailable',
      status: 'confirm',
      title: '公开访问还需要确认',
      explanation: '页面内容已经完成检查，但这次不带登录信息的公开请求没有取得完整响应。',
      checked: '尝试用不带 Cookie、登录信息和表单数据的请求读取当前页面。',
      impact: '暂时不能确认搜索引擎从服务器端得到的页面是否与浏览器一致。',
      action: '重新检查；如果仍失败，再让开发人员检查服务器访问规则，并用 Search Console 确认。',
      expectedResult: '重新检查能够读取到正式页面；Search Console 的实时测试也显示页面可以访问。',
      owner: '需要网站开发处理',
      actionTarget: 'search_access',
      developerMessage: `请检查 ${browserUrl} 的公开访问、CDN、WAF 和服务器日志。插件浏览器页面可读取，但匿名 GET 未取得完整响应：${pageProbe.error || '未返回状态码'}。`,
      confidence: 'low',
      technicalEvidence: evidence,
    };
  }

  return {
    id: 'overseas:search:public-access-ok',
    status: 'normal',
    title: '公开访问暂未发现问题',
    explanation: '浏览器页面和不带登录信息的公开访问都能读取当前页面。',
    checked: '比较了浏览器页面、公开请求状态和最终地址。',
    impact: '这是搜索引擎访问页面的必要条件，但不代表页面已经被 Google 收录或获得排名。',
    action: '继续使用 Search Console 确认 Google 实时读取结果。',
    expectedResult: 'Search Console 实时测试显示页面可访问；是否收录和排名仍需分别观察。',
    owner: '你可以自己完成',
    actionTarget: 'search_access',
    developerMessage: '',
    confidence: 'high',
    technicalEvidence: evidence,
  };
}

function expectedTrackingEvents(run: TrackingTestRun): string[] {
  return run.goal === 'custom' && run.customEvent
    ? [run.customEvent.toLocaleLowerCase()]
    : CORE_EVENTS[run.goal];
}

export function buildTrackingTestConclusion(run: TrackingTestRun | null | undefined): TrackingTestConclusion {
  if (!run) {
    return {
      status: 'untested',
      successfulAction: 'untested',
      failedAction: 'untested',
      messages: ['还没有进行成功和失败操作测试。'],
      technicalEvidence: [],
    };
  }
  const expected = expectedTrackingEvents(run);
  const events = run.observations.filter((item) => item.type === 'event' && expected.includes(item.name.toLocaleLowerCase()));
  const successMarker = run.observations.find((item) => item.name === 'user_confirmed_success');
  const failureMarker = run.observations.find((item) => item.name === 'user_confirmed_failure');
  const nearMarker = (marker: TrackingObservation | undefined, afterMs = -1) => marker
    ? events.filter((item) => item.relativeMs > afterMs && item.relativeMs <= marker.relativeMs && marker.relativeMs - item.relativeMs <= 15_000)
    : [];
  const successEvents = nearMarker(successMarker);
  const failureEvents = nearMarker(failureMarker, successMarker?.relativeMs ?? -1);
  const successEventsByPlatform = new Map<string, number>();
  successEvents.forEach((item) => successEventsByPlatform.set(item.platform, (successEventsByPlatform.get(item.platform) ?? 0) + 1));
  const duplicateCandidate = run.duplicateEvents.length > 0
    || [...successEventsByPlatform.values()].some((count) => count > 1);
  const successfulAction: TrackingTestConclusion['successfulAction'] = !successMarker
    ? 'untested'
    : duplicateCandidate
      ? 'duplicate_candidate'
      : successEvents.length > 0
        ? 'recorded_once'
        : 'not_observed';
  const failedAction: TrackingTestConclusion['failedAction'] = !failureMarker
    ? 'untested'
    : failureEvents.length
      ? 'recorded_candidate'
      : 'not_recorded';
  const status: OverseasSignalStatus = successfulAction === 'recorded_once' && failedAction === 'not_recorded'
    ? 'normal'
    : successfulAction === 'untested' || failedAction === 'untested'
      ? 'confirm'
      : 'attention';
  const successMessage = successfulAction === 'recorded_once'
    ? '成功操作被观察到记录一次。'
    : successfulAction === 'duplicate_candidate'
      ? '同一次成功操作可能被记录了两次。'
      : successfulAction === 'not_observed'
        ? '成功操作没有观察到记录。'
        : '还需要完成一次成功操作。';
  const failureMessage = failedAction === 'not_recorded'
    ? '失败操作没有被观察为转化。'
    : failedAction === 'recorded_candidate'
      ? '失败操作可能被错误算成转化。'
      : '还需要完成一次不会成功的操作。';
  return {
    status,
    successfulAction,
    failedAction,
    messages: [successMessage, failureMessage],
    technicalEvidence: [
      `测试目标：${run.goal === 'custom' ? run.customEvent || '自定义事件' : run.goal}`,
      `观察到目标事件：${events.length} 条`,
      `重复事件候选：${run.duplicateEvents.length} 项`,
    ],
  };
}

interface OverseasDiagnosisInput {
  snapshot: PageSnapshot;
  staticSnapshot: OverseasStaticSnapshot | null;
  settings: InternationalProjectSettings;
  trackingRun?: TrackingTestRun | null;
  googleVerification?: GoogleVerificationResult;
  expectedIndexState?: 'unknown' | 'index' | 'noindex';
  reconciliation?: TrackingReconciliationReport | null;
}

function findingCategoryFromTitle(title: string): OverseasDiagnosticFinding['category'] {
  if (/公开访问|入口|HTTPS|抓取|robots|收录|读取/.test(title)) return 'search_access';
  if (/语言|hreflang|Canonical|国际|地区|本地化/.test(title)) return 'international';
  return 'tracking';
}

type OverseasFindingDraft = Omit<OverseasDiagnosticFinding,
  'id' | 'kind' | 'category' | 'applicability' | 'directResult' | 'possibleEffect' | 'notGuaranteed'>
  & Partial<Pick<OverseasDiagnosticFinding,
    'id' | 'kind' | 'category' | 'applicability' | 'directResult' | 'possibleEffect' | 'notGuaranteed'>>;

function stableFindingId(category: OverseasDiagnosticFinding['category'], title: string): string {
  let hash = 2166136261;
  for (const character of title) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `overseas:${category}:${(hash >>> 0).toString(36)}`;
}

function finding(input: OverseasFindingDraft): OverseasDiagnosticFinding {
  const category = input.category ?? findingCategoryFromTitle(input.title);
  return {
    id: input.id ?? stableFindingId(category, input.title),
    kind: input.kind ?? 'issue',
    category,
    applicability: input.applicability ?? '适用于当前页面已经取得直接证据的情况。',
    directResult: input.directResult ?? '相关页面或追踪配置不再出现本次确认的直接异常。',
    possibleEffect: input.possibleEffect ?? '减少搜索系统理解、数据归因或业务判断中的不确定性。',
    notGuaranteed: input.notGuaranteed ?? '修复技术问题不能单独保证收录、排名、流量或业务增长。',
    ...input,
  };
}

function otherAnalytics(snapshot: OverseasStaticSnapshot | null): OtherAnalyticsSnapshot[] {
  if (!snapshot) return [];
  if (snapshot.otherAnalytics?.length) return snapshot.otherAnalytics.filter((item) => item.detected);
  const clarity = snapshot.tags.find((item) => item.platform === 'microsoft_clarity');
  return clarity && (clarity.scriptCount > 0 || clarity.initialized || clarity.requestObserved)
    ? [{ platform: 'microsoft_clarity', label: 'Microsoft Clarity', detected: true, scriptCount: clarity.scriptCount, requestObserved: clarity.requestObserved }]
    : [];
}

export function buildOverseasDiagnosis(input: OverseasDiagnosisInput): OverseasDiagnosis {
  const { snapshot, staticSnapshot, settings } = input;
  const access = searchAccessConclusion(snapshot);
  const recomputedInternational = buildInternationalSeo(snapshot, settings);
  const international = staticSnapshot ? {
    ...recomputedInternational,
    ...(staticSnapshot.internationalSeo.targets ? { targets: staticSnapshot.internationalSeo.targets } : {}),
    ...(staticSnapshot.internationalSeo.sitemapConsistency ? { sitemapConsistency: staticSnapshot.internationalSeo.sitemapConsistency } : {}),
    ...(staticSnapshot.internationalSeo.relatedCheck ? { relatedCheck: staticSnapshot.internationalSeo.relatedCheck } : {}),
  } : recomputedInternational;
  const effectiveStaticSnapshot = staticSnapshot ? { ...staticSnapshot, internationalSeo: international } : null;
  const tracking = buildTrackingTestConclusion(input.trackingRun);
  const robotsAllowed = snapshot.siteProbe.robots.agentAccess?.Googlebot !== false
    && snapshot.siteProbe.robots.agentAccess?.Bingbot !== false
    && snapshot.siteProbe.robots.allowed !== false;
  const canRead = Boolean(snapshot.titleTags[0] && snapshot.visibleTextLength > 0);
  const indexBlocked = snapshot.robotsMeta.some((item) => /\bnoindex\b/i.test(item))
    || /\bnoindex\b/i.test(snapshot.siteProbe.page.xRobotsTag);
  const verification = input.googleVerification && samePageUrl(input.googleVerification.pageUrl, snapshot.url)
    ? input.googleVerification
    : undefined;
  const normalItems: OverseasDiagnosis['normalItems'] = [];
  if (snapshot.url.startsWith('https://')) normalItems.push({ id: 'overseas:normal:https', title: '页面使用 HTTPS', evidence: '当前页面地址使用 HTTPS，没有从当前地址观察到协议降级。' });
  if (access.status === 'normal') normalItems.push({ id: 'overseas:normal:public-access', title: '公开访问返回正常页面', evidence: `公开请求返回 ${snapshot.siteProbe.page.status ?? 200}，最终地址与当前页面一致。` });
  if (international?.htmlLang && international.status === 'normal') normalItems.push({
    id: 'overseas:normal:language',
    title: `页面已经声明为 ${international.htmlLang}`,
    evidence: international.hreflangCount === 0
      ? '页面声明语言与正文未发现明显冲突；当前只发现一种语言版本，不需要设置 hreflang。'
      : '页面声明语言与正文未发现明显冲突，并已发现多语言关系声明。',
  });
  if (robotsAllowed) normalItems.push({ id: 'overseas:normal:robots', title: 'Google 和 Bing 未被抓取规则禁止', evidence: 'robots.txt 的 Googlebot、Bingbot 和通用规则未显示当前页面被禁止。' });
  if (canRead) normalItems.push({ id: 'overseas:normal:readable-content', title: '标题和主要内容可以读取', evidence: '当前浏览器页面包含可读取的标题与主要正文。' });

  const staticFindings = effectiveStaticSnapshot ? diagnoseOverseasStatic(effectiveStaticSnapshot, settings) : [];
  const issues = staticFindings.filter((item) => item.kind === 'issue');
  const opportunities = staticFindings.filter((item) => item.kind === 'opportunity');
  for (const reconciliationFinding of input.reconciliation?.findings ?? []) {
    (reconciliationFinding.kind === 'opportunity' ? opportunities : issues).push(reconciliationFinding);
  }
  if (access.status === 'attention') issues.unshift(finding({
    id: access.id, kind: 'issue', category: 'search_access', title: access.title, priority: 'P1', status: 'attention', confidence: access.confidence,
    evidence: access.explanation, why: access.impact, action: access.action, verification: access.expectedResult,
    platformConfirmation: '使用 Search Console 实时网址测试或服务器访问日志确认搜索引擎实际读取情况。', rollback: '只调整已确认造成异常的入口、CDN 或 WAF 规则，并保留原配置快照。',
    limitation: '一次匿名请求受网络、地区和 CDN 节点影响，不能单独证明 Googlebot 一直被阻止。',
    applicability: '适用于浏览器页面正常，但匿名公开请求取得错误状态或其他最终地址的情况。', directResult: '公开请求与浏览器访问收敛到同一正式页面和 200 响应。', possibleEffect: '降低搜索引擎因入口不稳定而无法读取正式页面的风险。', notGuaranteed: '入口恢复正常不代表页面已经收录或会获得排名。',
  }));
  if (!canRead) issues.push(finding({
    id: 'overseas:search:content-unreadable', category: 'search_access', title: '搜索引擎可读的主要内容不完整', priority: 'P1', status: 'attention', confidence: 'high',
    evidence: '当前页面缺少可读取的标题或主要正文。', why: '搜索系统难以判断页面主题，用户也看不到清晰的页面任务。', action: '在最终 HTML 或可稳定渲染的页面中补充唯一标题和主要正文。', verification: '重新扫描后可读取标题和正文，原始 HTML 与渲染结果不再缺失关键内容。', platformConfirmation: 'Search Console 实时渲染截图与已抓取 HTML。', rollback: '保留原页面模板版本，异常时回滚内容组件。', limitation: '当前结论只覆盖本次页面。',
  }));
  if (!robotsAllowed) issues.push(finding({
    id: 'overseas:search:robots-blocked', category: 'search_access', title: '抓取规则可能阻止 Google 或 Bing', priority: input.expectedIndexState === 'index' ? 'P1' : 'P2', status: 'attention', confidence: 'high',
    evidence: 'robots.txt 的 Googlebot、Bingbot 或通用规则显示当前页面可能被禁止。', why: '希望被搜索的公开页面若被禁止抓取，搜索引擎无法稳定读取页面。', action: '先确认页面是否应参与搜索，再精确缩小对应 Disallow 规则。', verification: 'robots 解析显示目标爬虫允许访问当前路径，正式页面继续返回 200。', platformConfirmation: 'Search Console robots 测试、URL 检查或服务器日志。', rollback: '保存原 robots.txt，只修改相关路径并准备恢复。', limitation: '索引目标未知时只确认规则冲突，不断言必须开放。',
  }));
  if (indexBlocked && input.expectedIndexState === 'index') issues.push(finding({
    id: 'overseas:search:indexing-disabled', category: 'search_access', title: '页面明确禁止被搜索收录', priority: 'P1', status: 'attention', confidence: 'high',
    evidence: '页面 robots meta 或 X-Robots-Tag 包含 noindex，且页面目标已确认为允许收录。', why: 'noindex 是明确的禁止收录指令。', action: '移除错误的 noindex，并确认页面模板和响应头不会重复添加。', verification: '页面不再返回 noindex，Search Console 实时测试显示允许编入索引。', platformConfirmation: 'Search Console URL 检查。', rollback: '保留原模板和响应头配置；若页面本应私密或不收录则恢复。', limitation: '允许收录不等于已经收录。',
  }));
  if (verification?.result === 'issue') issues.push(finding({
    id: 'overseas:search:google-live-test-issue', category: 'search_access', title: 'Google 实时读取显示存在问题', priority: 'P1', status: 'attention', confidence: 'high',
    evidence: '用户已经记录 Search Console 实时测试存在问题。', why: 'Google 当前读取页面时可能遇到状态码、robots、重定向、Canonical 或渲染问题。', action: '按 Search Console 的具体错误类型修正，而不是仅根据插件分数修改。', verification: '再次测试后 Google 显示可以访问。', platformConfirmation: 'Search Console 实时 URL 测试。', rollback: '一次只修改一个直接根因并保留原配置。', limitation: '实时可访问仍不等于已经收录或有排名。',
  }));
  if (tracking.status === 'attention') issues.push(finding({
    id: 'overseas:tracking:test-failed', category: 'tracking', title: '客户操作记录存在漏发、重复或误计', priority: 'P1', status: 'attention', confidence: 'high',
    evidence: tracking.messages.join(' '), why: '漏记、重复或把失败操作记成转化会让分析与广告平台数据失真。', action: '根据时间线检查事件触发条件、接口成功回调和重复安装来源。', verification: '一次成功业务只记录一次主要事件，失败操作不记录为转化。', platformConfirmation: 'GA4 DebugView、GTM Preview 和广告平台转化诊断。', rollback: '保留原 GTM 容器或代码版本，逐项回退触发条件。', limitation: '现场观察不能证明平台最终采用了数据。',
  }));
  const entryFailures = snapshot.technical?.transport.variants.filter((item) => item.error || item.status === null || item.status >= 400) ?? [];
  if (entryFailures.length) issues.push(finding({
    id: 'overseas:search:host-entry-risk', category: 'search_access', title: '网站入口存在 HTTPS 或响应失败风险', priority: 'P1', status: 'attention', confidence: 'medium',
    evidence: entryFailures.map((item) => `${item.requestedUrl}：${item.status ?? '无状态'}${item.error ? `，${item.error}` : ''}`).join('；'), why: '同一网站的协议或主机入口若不能稳定收敛，用户和搜索引擎可能访问到不同结果。', action: '让服务器或 CDN 将 HTTP/HTTPS、www/非 www 统一到一个可用的正式地址，并修复失败入口的证书或路由。', verification: '完整入口检查中的每个已授权入口都能安全访问并收敛到同一正式地址。', platformConfirmation: '证书监控、CDN 日志和 Search Console 属性设置。', rollback: '保留入口、证书和 CDN 规则快照，按单条规则回滚。', limitation: '入口检查只代表本次网络和已授权地址，不能证明全球所有节点稳定。',
  }));

  const evidenceGaps: OverseasDiagnosis['evidenceGaps'] = [
    {
      id: 'overseas:boundary:indexing-ranking', title: '实际收录和排名需要搜索平台数据',
      confirmed: verification?.result === 'accessible' ? '用户记录的 Google 实时测试可以读取当前页面。' : '插件已检查页面代码、抓取指令和公开访问证据。',
      unavailable: '仅凭网页代码不能证明页面已经收录、当前排名或当地搜索表现。',
      limitation: 'Search Console 实时可访问也不等于已经收录或有排名。',
    },
    {
      id: 'overseas:boundary:platform-business', title: '平台接收和真实业务结果需要后台证据',
      confirmed: input.trackingRun ? `本机已保存一次脱敏现场测试摘要，状态为 ${input.trackingRun.status}。` : '静态扫描只确认标签、初始化和本次浏览器请求。',
      unavailable: input.reconciliation ? '已有导入报表核对结果，但插件仍不直接读取平台账户或后端原始业务。' : '尚无现场测试或报表证据证明平台收到数据并对应有效线索、订单、退款或毛利。',
      limitation: '标签存在、浏览器发出请求、平台接收和后端有效业务是四个不同事实层。',
    },
  ];
  if (access.status === 'confirm') evidenceGaps.push({ id: 'overseas:boundary:public-access', title: '公开访问结果本次无法确认', confirmed: '浏览器中的页面内容仍已完成语言、标题、链接和标签检查。', unavailable: '匿名请求没有取得完整响应，不能判断服务器返回是否与浏览器一致。', limitation: '请求失败不会阻断 DOM 检查，也不会被直接写成 Google 无法抓取。' });
  const permissionLimitations = snapshot.technical?.limitations.filter((item) => /授权|权限|origin/i.test(item)) ?? [];
  if (permissionLimitations.length) evidenceGaps.push({ id: 'overseas:boundary:entry-permission', title: '部分网站入口未取得读取权限', confirmed: '已使用当前页面和已授权入口的证据。', unavailable: permissionLimitations.join('；'), limitation: '未授权入口只作为检测边界，不自动请求权限，也不生成网站问题。' });
  if (international.relatedCheck?.skippedOrigins.length) evidenceGaps.push({
    id: 'overseas:boundary:related-origin-permission',
    title: '部分跨域关联版本尚未检查',
    confirmed: international.relatedCheck.checkedUrls.length
      ? `已自动检查 ${international.relatedCheck.checkedUrls.length} 个同源或已授权关联版本。`
      : '当前页面的语言、Canonical 和关联声明已经完成检查。',
    unavailable: `以下跨域地址没有读取权限：${international.relatedCheck.skippedOrigins.join('、')}。`,
    limitation: '插件不会在自动扫描时弹出跨域权限；未检查的地址只作为检测边界，不生成问题。',
  });
  const unique = <T extends { id: string }>(items: T[]) => [...new Map(items.map((item) => [item.id, item])).values()];
  const result = {
    checkedItems: [
    '浏览器页面与公开访问结果',
    '页面语言和多语言关系',
    'Google/Bing 抓取规则',
    'Google Analytics 与广告标签',
    '页面标题和主要内容',
    ],
    normalItems: unique(normalItems),
    issues: unique(issues),
    opportunities: unique(opportunities),
    evidenceGaps: unique(evidenceGaps),
    otherAnalytics: otherAnalytics(effectiveStaticSnapshot),
  };
  return { ...result, normalCount: result.normalItems.length, issueCount: result.issues.length, opportunityCount: result.opportunities.length };
}

export function buildOverseasSummary(input: OverseasDiagnosisInput): OverseasSummary {
  const { snapshot, staticSnapshot, settings } = input;
  const diagnosis = buildOverseasDiagnosis(input);
  const access = searchAccessConclusion(snapshot);
  const googleTags = staticSnapshot?.tags.filter((tag) => tag.platform.startsWith('google_')) ?? [];
  const gaTag = googleTags.find((tag) => tag.platform === 'google_analytics');
  const adsTag = googleTags.find((tag) => tag.platform === 'google_ads');
  const tracking = buildTrackingTestConclusion(input.trackingRun);
  const indexBlocked = snapshot.robotsMeta.some((item) => /\bnoindex\b/i.test(item)) || /\bnoindex\b/i.test(snapshot.siteProbe.page.xRobotsTag);
  const canRead = Boolean(snapshot.titleTags[0] && snapshot.visibleTextLength > 0);
  const verification = input.googleVerification && samePageUrl(input.googleVerification.pageUrl, snapshot.url) ? input.googleVerification : undefined;
  const adEvidence = Boolean(adsTag?.ids.length || adsTag?.scriptCount || adsTag?.initialized || adsTag?.requestObserved);
  const adApplicable = settings.useGoogleAds || adEvidence;
  return {
    ...diagnosis,
    searchAccess: access,
    googleSearch: {
      canOpen: access.status,
      canRead: canRead ? 'normal' : 'attention',
      indexAllowed: indexBlocked ? 'attention' : 'normal',
      indexed: 'unavailable',
      indexedExplanation: verification?.result === 'accessible'
        ? 'Google 实时读取成功；这仍不代表页面已经收录或有排名。'
        : verification?.result === 'issue'
          ? '你已确认 Google 实时读取存在问题，请按 Search Console 的错误类型处理。'
          : verification?.result === 'unclear'
            ? '结果尚未看懂，可截图或复制结果交给 AI 深度解读。'
            : '插件无法仅凭网页代码判断是否已收录，需要 Search Console 确认。',
    },
    googleAnalytics: {
      tag: gaTag && (gaTag.ids.length || gaTag.scriptCount) ? 'normal' : 'confirm',
      initialized: gaTag?.initialized ? 'normal' : gaTag && (gaTag.ids.length || gaTag.scriptCount) ? 'confirm' : 'untested',
      request: gaTag?.requestObserved ? 'normal' : gaTag && (gaTag.ids.length || gaTag.scriptCount) ? 'confirm' : 'untested',
      platform: 'confirm',
    },
    googleAds: {
      applicable: adApplicable,
      status: !adApplicable ? 'normal' : adsTag?.requestObserved ? 'normal' : adEvidence ? 'confirm' : 'attention',
      explanation: !adApplicable
        ? '当前没有发现需要检查的 Google Ads 投放证据。'
        : adsTag?.requestObserved
          ? '已观察到 Google Ads 请求，后台接收和真实业务仍需继续确认。'
          : '已确认投放或发现 Ads 标签，但还没有观察到完整的转化请求证据。',
    },
    tracking,
  };
}

export function buildOverseasStaticSnapshot(
  snapshot: PageSnapshot,
  settings: InternationalProjectSettings,
  input: StaticAnalyticsInput,
): OverseasStaticSnapshot {
  const allTexts = [...input.scriptUrls, ...input.inlineScriptText, ...input.resourceUrls];
  const resourceTexts = [...input.resourceUrls, ...input.scriptUrls];
  const commands = safeCommandEntries(input.dataLayerEntries);
  const uetCommands = safeCommandEntries(input.uetEntries);
  const googleIds = allTexts.flatMap((value) => uniqueMatches([value], /\bG-[A-Z0-9]+\b/gi));
  const gtmIds = allTexts.flatMap((value) => uniqueMatches([value], /\bGTM-[A-Z0-9]+\b/gi));
  const adsIds = allTexts.flatMap((value) => uniqueMatches([value], /\bAW-[0-9]+\b/gi));
  const uaIds = allTexts.flatMap((value) => uniqueMatches([value], /\bUA-[0-9]+-[0-9]+\b/gi));
  const uetIds = [...new Set(allTexts.flatMap((value) => [...value.matchAll(/(?:ti|uetq)["'\s:=,]+([0-9]{5,})/gi)]
    .map((match) => match[1])
    .filter((id): id is string => Boolean(id))))];
  const googleRequests = resourceTexts.filter((url) => /google-analytics\.com\/(?:g\/)?collect|analytics\.google\.com\/g\/collect/i.test(url));
  const googleAdsRequests = resourceTexts.filter((url) => /(?:googleadservices\.com|googleads\.g\.doubleclick\.net|doubleclick\.net|google\.[^/]+\/pagead\/(?:1p-)?conversion)/i.test(url));
  const bingRequests = resourceTexts.filter((url) => /bat\.bing\.com/i.test(url));
  const clarityRequests = resourceTexts.filter((url) => /clarity\.ms/i.test(url));
  const baiduRequests = resourceTexts.filter((url) => /(?:hm|tongji)\.baidu\.com/i.test(url));
  const googleScripts = input.scriptUrls.filter((url) => /googletagmanager\.com|google-analytics\.com/i.test(url));
  const bingScripts = input.scriptUrls.filter((url) => /bat\.bing\.com|clarity\.ms/i.test(url));
  const baiduScripts = input.scriptUrls.filter((url) => /(?:hm|tongji)\.baidu\.com/i.test(url));
  const events = commands.map((item) => item.event).filter(Boolean);
  const uetEvents = uetCommands.map((item) => item.event).filter(Boolean);
  const tags = [
    tag('google_analytics', [...googleIds, ...uaIds], googleScripts, commands.some((item) => item.command === 'config'), googleRequests.length > 0, events, { oldUa: uaIds.length > 0, mixed: gtmIds.length > 0 && googleIds.length > 0 }),
    tag('google_tag_manager', gtmIds, googleScripts.filter((url) => /gtm\.js/i.test(url)), gtmIds.length > 0, googleScripts.some((url) => /gtm\.js/i.test(url)), events),
    tag('google_ads', adsIds, googleScripts, adsIds.length > 0, googleAdsRequests.length > 0, events),
    tag('bing_uet', uetIds, bingScripts.filter((url) => /bat\.bing\.com/i.test(url)), input.uetEntries.length > 0, bingRequests.length > 0, uetEvents),
    tag('microsoft_clarity', [], bingScripts.filter((url) => /clarity\.ms/i.test(url)), bingScripts.some((url) => /clarity\.ms/i.test(url)), clarityRequests.length > 0, []),
  ];
  const initialUrl = new URL(input.currentUrl);
  let finalUrl: URL | null = null;
  try { finalUrl = new URL(input.finalUrl || input.currentUrl); } catch { finalUrl = null; }
  const clickParameters = TRACKING_PARAMETER_NAMES.map((name) => ({
    name,
    present: initialUrl.searchParams.has(name),
    preservedAfterRedirect: initialUrl.href === finalUrl?.href || !initialUrl.searchParams.has(name)
      ? null
      : Boolean(finalUrl?.searchParams.has(name)),
  }));
  return {
    checkedAt: new Date().toISOString(),
    tags,
    consent: consentSnapshot(commands),
    internationalSeo: buildInternationalSeo(snapshot, settings),
    clickParameters,
    otherAnalytics: [
      { platform: 'baidu_tongji', label: '百度统计', detected: baiduScripts.length > 0 || baiduRequests.length > 0, scriptCount: baiduScripts.length, requestObserved: baiduRequests.length > 0 },
      { platform: 'microsoft_clarity', label: 'Microsoft Clarity', detected: bingScripts.some((url) => /clarity\.ms/i.test(url)) || clarityRequests.length > 0, scriptCount: bingScripts.filter((url) => /clarity\.ms/i.test(url)).length, requestObserved: clarityRequests.length > 0 },
    ],
    limitations: [
      '页面存在标签不代表 GA4、Google Ads 或 Microsoft Ads 后台已经收到并采用数据。',
      '广告拦截、同意状态和浏览器隐私设置可能使单次请求不可见。',
      '真实业务结果必须通过后端或业务 CSV 核对。',
    ],
  };
}

export function sanitizeTrackingObservation(input: TrackingObservation): TrackingObservation {
  const sensitive = input.fields.sensitiveField || SENSITIVE_NAME.test(input.name);
  return {
    id: input.id.slice(0, 80),
    platform: input.platform,
    type: input.type,
    name: SENSITIVE_NAME.test(input.name) ? '疑似敏感字段事件' : input.name.slice(0, 100),
    relativeMs: Math.max(0, Math.round(input.relativeMs)),
    fields: { ...input.fields, sensitiveField: sensitive },
  };
}

export function validateTrackingObservation(input: unknown): TrackingObservation | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.relativeMs !== 'number' || !Number.isFinite(raw.relativeMs)) return null;
  if (!TRACKING_PLATFORMS.has(raw.platform as TrackingObservation['platform']) || !TRACKING_TYPES.has(raw.type as TrackingObservation['type'])) return null;
  const fields = raw.fields && typeof raw.fields === 'object' ? raw.fields as Record<string, unknown> : {};
  const observation: TrackingObservation = {
    id: raw.id,
    platform: raw.platform as TrackingObservation['platform'],
    type: raw.type as TrackingObservation['type'],
    name: raw.name,
    relativeMs: raw.relativeMs,
    fields: {
      eventId: fields.eventId === true,
      transactionId: fields.transactionId === true,
      value: fields.value === true,
      currency: fields.currency === true,
      items: fields.items === true,
      sensitiveField: fields.sensitiveField === true,
      ...(typeof fields.targetId === 'string' && /^(?:(?:G|GTM|AW)-[A-Z0-9-]+|\d{5,})$/i.test(fields.targetId)
        ? { targetId: fields.targetId }
        : {}),
    },
  };
  return sanitizeTrackingObservation(observation);
}

export function normalizeTrackingPage(value: string): string {
  try {
    const url = new URL(value, 'https://seo-opt.invalid');
    url.hash = '';
    [...url.searchParams.keys()].forEach((key) => { if (TRACKING_QUERY_PARAMETER.test(key)) url.searchParams.delete(key); });
    url.searchParams.sort();
    const pathname = url.pathname !== '/' ? url.pathname.replace(/\/+$/, '') : '/';
    return url.origin === 'https://seo-opt.invalid' ? `${pathname}${url.search}` : `${url.origin}${pathname}${url.search}`;
  } catch {
    return value.trim();
  }
}

function stage(id: TrackingChainStage['id'], label: string, observations: TrackingObservation[], names: string[]): TrackingChainStage {
  const matched = observations.some((item) => names.includes(item.name.toLocaleLowerCase()));
  return { id, label, status: matched ? 'normal' : 'confirm', evidence: matched ? `现场观察到 ${names.join(' / ')}。` : '当前测试尚未取得直接证据。', evidenceLayer: matched ? 'browser' : 'platform' };
}

export function finalizeTrackingRun(run: TrackingTestRun): TrackingTestRun {
  const observations = run.observations.slice(-200).map(sanitizeTrackingObservation);
  const eventNames = observations.filter((item) => item.type === 'event').map((item) => item.name.toLocaleLowerCase());
  const duplicateKeys = new Map<string, TrackingObservation[]>();
  observations.filter((item) => item.type === 'event').forEach((item) => {
    const key = `${item.platform}:${item.name.toLocaleLowerCase()}`;
    duplicateKeys.set(key, [...(duplicateKeys.get(key) ?? []), item]);
  });
  const expected = run.goal === 'custom' && run.customEvent ? [run.customEvent.toLocaleLowerCase()] : CORE_EVENTS[run.goal];
  const failedMarker = observations.find((item) => item.name === 'user_confirmed_failure');
  const successMarker = observations.find((item) => item.name === 'user_confirmed_success');
  const keyEventBefore = (marker: TrackingObservation | undefined, afterMs = -1) => marker
    ? observations.some((item) => item.type === 'event' && expected.includes(item.name.toLocaleLowerCase()) && item.relativeMs > afterMs && item.relativeMs <= marker.relativeMs && marker.relativeMs - item.relativeMs <= 15_000)
    : false;
  const stages: TrackingChainStage[] = [
    { id: 'landing', label: '进入落地页', status: 'normal', evidence: `测试开始于 ${run.startedAt}。`, evidenceLayer: 'browser' },
    { id: 'source', label: '识别访问来源', status: observations.some((item) => item.name === 'click_parameter') ? 'normal' : 'confirm', evidence: '根据点击标识和 UTM 现场观察。', evidenceLayer: 'page' },
    stage('page_view', '发送页面浏览', observations, ['page_view']),
    { id: 'action', label: '用户执行操作', status: run.successfulActionObserved && run.failedActionObserved ? 'normal' : 'confirm', evidence: run.successfulActionObserved && run.failedActionObserved ? '用户已标记成功和失败操作各完成一次。' : '需要用户确认成功和失败操作各执行一次。', evidenceLayer: 'user_input' },
    stage('analytics_event', '发送关键分析事件', observations, expected),
    { id: 'business_result', label: '产生线索或订单', status: 'unavailable', evidence: '浏览器不能证明后端业务记录，需要业务数据核对。', evidenceLayer: 'backend' },
    { id: 'ad_import', label: '广告平台接收有效转化', status: 'unavailable', evidence: '需要 Google Ads 或 Microsoft Ads 后台/导出数据确认。', evidenceLayer: 'platform' },
  ];
  return {
    ...run,
    endedAt: run.endedAt ?? new Date().toISOString(),
    observations,
    stages,
    duplicateEvents: [...duplicateKeys].filter(([, items]) => items.some((item, index) => index > 0 && item.relativeMs - items[index - 1]!.relativeMs < 1_500)).map(([key]) => key),
    sensitiveFieldNames: observations.filter((item) => item.fields.sensitiveField).map((item) => item.name),
    limitations: [
      ...run.limitations.filter((item) => !item.startsWith('失败路径判断：')),
      `失败路径判断：${failedMarker ? keyEventBefore(failedMarker, successMarker?.relativeMs ?? -1) ? '成功确认后到失败确认前观察到主要事件，存在误计候选。' : '成功确认后到失败确认前未观察到主要事件。' : '用户尚未标记失败操作。'} 成功路径：${successMarker ? keyEventBefore(successMarker) ? '观察到主要事件。' : '未观察到主要事件，需要复核。' : '用户尚未标记成功操作。'}`,
    ],
  };
}

export function diagnoseOverseasStatic(
  snapshot: OverseasStaticSnapshot,
  settings: InternationalProjectSettings,
): OverseasDiagnosticFinding[] {
  const findings: OverseasDiagnosticFinding[] = [];
  const googleTags = snapshot.tags.filter((item) => item.platform.startsWith('google_'));
  const bingTags = snapshot.tags.filter((item) => item.platform === 'bing_uet' || item.platform === 'microsoft_clarity');
  if (settings.useGoogleAds && !googleTags.some((item) => item.requestObserved)) findings.push(finding({
    id: 'overseas:tracking:google-ads-request-missing', category: 'tracking', title: '正在投放 Google Ads，但没有观察到 Google 收集请求', priority: 'P1', status: 'attention', confidence: 'high',
    evidence: googleTags.some((item) => item.ids.length || item.initialized) ? '页面存在 Google 标签或初始化证据，但本次访问没有观察到收集请求。' : '页面没有识别到 GA4、GTM 或 Google Ads 标签，也没有观察到收集请求。',
    why: '广告点击和页面转化可能无法进入分析或广告学习链路，平台 CPA/ROAS 会失去可信基础。',
    action: '先确认标签覆盖所有落地页，再检查 Consent 默认状态、GTM 触发条件和请求是否被 CSP 或广告拦截器阻止。',
    codeExample: "gtag('config', 'G-XXXXXXX');\ngtag('event', 'generate_lead', { send_to: 'AW-XXXXXXX/label' });",
    verification: '使用测试流量开始一次现场追踪，确认页面浏览和主要转化各出现一次；随后到 GA4 DebugView 与 Google Ads 转化诊断确认。',
    platformConfirmation: 'GA4 数据流/DebugView、GTM Preview、Google Ads 转化操作状态与主要/次要设置。',
    rollback: '发布前导出 GTM 容器版本或保留原代码版本；异常时恢复原标签配置。',
    limitation: '广告拦截、Consent 拒绝和单次访问网络波动会使请求暂时不可见，浏览器观察不能证明平台一定没有收到其他访问的数据。',
    applicability: '仅在已经确认当前网站正在投放 Google Ads 时适用。', directResult: '主要落地页能够在正确同意状态下发送一次预期分析或广告请求。', possibleEffect: '广告转化诊断和自动出价可获得更完整的浏览器侧信号。', notGuaranteed: '观察到请求不能保证 Google Ads 后台已接收、归因或用于出价。',
  }));
  if (settings.useMicrosoftAds && !bingTags.some((item) => item.platform === 'bing_uet' && item.requestObserved)) findings.push(finding({
    id: 'overseas:tracking:microsoft-ads-uet-missing', category: 'tracking', title: '正在投放 Microsoft Ads，但没有观察到 UET 请求', priority: 'P1', status: 'attention', confidence: 'high',
    evidence: bingTags.some((item) => item.ids.length || item.initialized) ? '页面存在 UET/Clarity 脚本候选，但本次访问没有观察到 UET 收集请求。' : '页面没有识别到 UET 标签或 bat.bing.com 请求。',
    why: 'Microsoft Ads 无法可靠学习主要转化，搜索词、出价与再营销判断都会受到影响。',
    action: '确认基础 UET 覆盖落地页和转化页，并检查 Tag ID、CMP 同意条件以及 SPA 页面浏览触发。Clarity 不能替代 UET 转化。',
    codeExample: "window.uetq = window.uetq || [];\nwindow.uetq.push('event', 'submit_lead', {});",
    verification: '现场测试观察到 UET 请求后，再用 Microsoft UET Tag Helper 和广告后台目标状态复核。',
    platformConfirmation: 'Microsoft Advertising 的 UET 标签、转化目标和目标状态。',
    rollback: '保留原 GTM/UET 发布版本，出现重复事件时恢复并逐个触发器排查。',
    limitation: 'Clarity 请求只证明体验分析脚本运行，不代表 UET 或 Microsoft Ads 转化已收到。',
    applicability: '仅在已经确认当前网站正在投放 Microsoft Ads 时适用。', directResult: '主要落地页能够发送一次预期 UET 页面或转化请求。', possibleEffect: 'Microsoft Ads 可获得更完整的浏览器侧转化信号。', notGuaranteed: 'Clarity 或 UET 请求存在都不能单独证明广告后台已接收有效转化。',
  }));
  for (const tagSnapshot of snapshot.tags) {
    if (tagSnapshot.oldUniversalAnalytics) findings.push(finding({
      id: 'overseas:tracking:legacy-universal-analytics', category: 'tracking', title: '页面仍包含旧版 Universal Analytics', priority: 'P1', status: 'attention', confidence: 'high', evidence: `识别到旧 UA ID：${tagSnapshot.ids.filter((id) => id.startsWith('UA-')).join('、')}。`,
      why: 'Universal Analytics 已停止标准数据处理，旧标签会制造“装了分析但没有可用数据”的错觉。', action: '移除已确认无依赖的 UA 配置，迁移到 GA4 Measurement ID，并重新定义关键事件。',
      codeExample: "gtag('config', 'G-XXXXXXX');", verification: '页面源代码不再包含 UA-*，现场观察到 GA4 page_view，并在 GA4 DebugView 确认。', platformConfirmation: 'GA4 数据流和事件列表。', rollback: '先记录旧 UA 用途和依赖；GA4 验证前不要直接删除唯一仍在使用的业务报表。', limitation: '检测到字符串不一定代表代码实际执行，仍需核对标签来源。',
    }));
    if (tagSnapshot.duplicateIds.length) findings.push(finding({
      id: `overseas:tracking:duplicate-id:${tagSnapshot.platform}`, kind: 'opportunity', category: 'tracking', title: `${tagSnapshot.platform} 存在重复 ID 候选`, priority: 'P2', status: 'confirm', confidence: 'medium', evidence: `重复候选：${tagSnapshot.duplicateIds.join('、')}。`, why: '同一标签被多次安装可能造成页面浏览或转化重复，进而虚高转化和误导自动出价。',
      action: '逐一确认硬编码、GTM、CMS 插件和同意管理器的安装来源，只保留一个受控入口。', codeExample: "// 在 GTM Preview 中确认同一事件只触发一个 GA4/Ads 标签。",
      verification: '同一页面加载只观察到一次 page_view；同一成功业务只出现一次主要转化。', platformConfirmation: 'GA4 DebugView、GTM Preview 与广告平台转化诊断。', rollback: '停用重复来源前保存 GTM 版本或代码差异。', limitation: '页面文本中的相同 ID 可能来自配置展示而非真实执行，因此先作为候选。', applicability: '仅在现场请求或 GTM Preview 进一步证明同一事件重复时才应删除安装来源。', directResult: '同一页面浏览或业务结果只由一个受控来源发送。', possibleEffect: '减少分析和广告转化虚高的风险。', notGuaranteed: '页面中出现重复 ID 字符串不等于真实重复发送。',
    }));
    if (tagSnapshot.hardcodedAndTagManagerCandidate) findings.push(finding({
      id: 'overseas:tracking:gtm-hardcoded-candidate', kind: 'opportunity', category: 'tracking', title: 'GTM 与硬编码 gtag 可能同时发送', priority: 'P2', status: 'confirm', confidence: 'medium', evidence: '同一页面同时识别到 GTM 容器和 GA4 Measurement ID。', why: '两种安装方式可以共存，但若都发送同一事件会造成重复。', action: '在 GTM Preview 和现场时间线中按事件核对，不要仅因两者共存就删除代码。',
      verification: '页面浏览、主要转化和购买事件分别只发送一次。', platformConfirmation: 'GTM Preview 与 GA4 DebugView。', rollback: '一次只停用一个来源，并保留原容器版本。', limitation: '共存不等于重复；必须用运行证据确认。', applicability: '仅在页面同时安装 GTM 与硬编码 Google 标签时适用。', directResult: '每个关键事件的发送来源和触发条件清晰且不重复。', possibleEffect: '提高分析和广告转化数据的可信度。', notGuaranteed: '共存本身不是错误，也不能据此直接删除任一标签。',
    }));
  }
  if (snapshot.consent.updateSeen && !snapshot.consent.defaultSeen) findings.push(finding({
    id: 'overseas:tracking:consent-default-order', category: 'tracking', title: '观察到 Consent 更新，但没有默认状态', priority: 'P1', status: 'attention', confidence: 'medium', evidence: snapshot.consent.explanation, why: '默认状态若在标签运行后才设置，页面可能先发送不符合预期的分析或广告请求。', action: '在任何 Google 标签初始化前设置 Consent default，再由 CMP 根据用户选择发送 update；具体合法性需由目标市场合规人员确认。',
    codeExample: "gtag('consent', 'default', { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });",
    verification: '清空站点数据后重新加载，时间线中 default 早于 config/request，用户选择后才出现 update。', platformConfirmation: 'GTM Consent Overview 和 CMP 配置。', rollback: '保存 CMP/GTM 原版本；若业务事件被阻断，恢复后重新检查触发顺序。', limitation: '插件只观察页面现场，不提供法律合规认证。',
  }));
  const lost = snapshot.clickParameters.filter((item) => item.present && item.preservedAfterRedirect === false);
  if (lost.length) findings.push(finding({
    id: 'overseas:tracking:click-parameter-loss', category: 'tracking', title: '跳转后丢失广告点击或 UTM 参数', priority: 'P1', status: 'attention', confidence: 'high', evidence: `丢失参数：${lost.map((item) => item.name).join('、')}。`, why: '点击来源无法进入后续会话或业务链路，会降低广告归因与离线转化匹配率。', action: '检查 HTTP/HTTPS、主机、语言跳转和登录/结账跨域是否保留允许的查询参数，并避免把敏感数据塞进 URL。',
    codeExample: "const next = new URL('/en/landing', location.origin);\nfor (const key of ['gclid','gbraid','wbraid','msclkid','utm_source','utm_medium','utm_campaign']) { const value = new URL(location.href).searchParams.get(key); if (value) next.searchParams.set(key, value); }",
    verification: '使用虚拟测试参数访问入口，检查每次跳转和最终页面仍保留参数，再核对后端只保存业务允许的归因字段。', platformConfirmation: '广告自动标记、GA4 会话来源和离线转化上传匹配率。', rollback: '上线前记录原跳转规则；异常时恢复，并避免开放任意参数透传。', limitation: '本检查只比较当前请求与最终地址，跨页面后端保存仍需业务系统证明。',
  }));
  const internationalIssues = [
    ...snapshot.internationalSeo.issues,
    ...(snapshot.internationalSeo.targets ?? []).flatMap((target) => target.issue
      ? [`${target.kind === 'mobile' ? '移动版本' : `${target.lang} 语言页`}：${target.issue}`]
      : []),
  ];
  for (const issue of internationalIssues) findings.push(finding({
    id: stableFindingId('international', issue), category: 'international', title: issue, priority: /noindex|404|Canonical/.test(issue) ? 'P1' : 'P2', status: 'attention', confidence: snapshot.internationalSeo.languageConfidence === 'low' ? 'low' : 'medium', evidence: `页面语言 ${snapshot.internationalSeo.htmlLang || '未声明'}，目标语言 ${snapshot.internationalSeo.targetLanguage || '未设置'}，hreflang ${snapshot.internationalSeo.hreflangCount} 条。`,
    why: '搜索引擎需要明确每个语言/地区页面服务谁，以及这些页面之间是什么关系；冲突会让错误版本参与排序或被选作规范页。', action: '先确认页面实际服务语言和地区，再修正 html lang、Canonical 和 hreflang；每个可索引语言页应自引用，并与对应页互返。',
    codeExample: '<link rel="alternate" hreflang="{{CURRENT_LANGUAGE}}" href="{{PAGE_URL}}" />\n<link rel="alternate" hreflang="{{ALTERNATE_LANGUAGE}}" href="{{ALTERNATE_PAGE_URL}}" />',
    verification: '关联语言页应返回 200、可索引，Canonical 指向自身或正确规范页，并互相声明相同语言集合。', platformConfirmation: 'Google Search Console URL 检查与 Bing Webmaster Tools 抓取/索引报告。', rollback: '发布前保存旧模板；批量异常时恢复模板并重新生成 Sitemap。', limitation: '正文语言识别是候选；低置信度时必须人工确认，插件不模拟海外 IP 或当地排名。',
  }));
  const ga = snapshot.tags.find((item) => item.platform === 'google_analytics');
  const gtm = snapshot.tags.find((item) => item.platform === 'google_tag_manager');
  const hasGa4OrGtm = Boolean(
    ga?.ids.some((id) => id.startsWith('G-')) || ga?.initialized || ga?.requestObserved
    || gtm?.ids.length || gtm?.initialized || gtm?.requestObserved,
  );
  if (!hasGa4OrGtm) {
    const discovered = otherAnalytics(snapshot).map((item) => item.label);
    findings.push(finding({
      id: 'overseas:tracking:measurement-google-bing', kind: 'opportunity', category: 'tracking', title: '建立可核对到业务结果的海外流量分析链路', priority: 'P2', status: 'confirm', confidence: 'high',
      evidence: discovered.length ? `当前页面发现 ${discovered.join('、')}，但未发现 GA4 或 GTM 的标签、初始化或请求证据。` : '当前页面未发现 GA4 或 GTM 的标签、初始化或请求证据。',
      why: '如果网站要衡量 Google/Bing 自然搜索、海外内容或广告效果，需要把访问、关键事件和有效业务分层核对。其他统计工具不能证明 Google Analytics 或广告转化链路正常。',
      action: '先定义一个真实核心转化，再选择 GA4 直接安装或 GTM 统一管理；事件只在业务成功后发送，并用后端有效结果复核。',
      codeExample: "<!-- 仅示意：把 G-XXXXXXX 替换为真实 GA4 Measurement ID -->\n<script async src=\"https://www.googletagmanager.com/gtag/js?id=G-XXXXXXX\"></script>\n<script>\n  window.dataLayer = window.dataLayer || [];\n  function gtag(){ dataLayer.push(arguments); }\n  gtag('js', new Date());\n  gtag('config', 'G-XXXXXXX');\n</script>",
      verification: '页面只初始化一次真实 Measurement ID；一次成功业务只发送一次关键事件，失败业务不发送。', platformConfirmation: 'GA4 DebugView、数据流与后端有效业务报表。', rollback: '保留原统计代码和 GTM 版本；发现重复或业务异常时只回退新增安装来源。', limitation: '没有 GA4/GTM 不一定是错误；网站可能选择其他分析体系，插件也不能读取平台后台。',
      applicability: '仅在需要衡量 Google/Bing 海外流量、内容或广告效果时适用。', directResult: '页面访问和核心转化进入一个可现场验证、可与业务结果核对的分析链路。', possibleEffect: '更准确地区分自然搜索、广告和真实业务结果，为内容与投放决策提供依据。', notGuaranteed: '安装 GA4/GTM 不会自动提高排名、流量或转化，也不能替代正确的事件与业务口径。',
    }));
  }
  const targetDiffers = Boolean(settings.targetLanguage && snapshot.internationalSeo.htmlLang && baseLanguage(settings.targetLanguage) !== baseLanguage(snapshot.internationalSeo.htmlLang));
  if (snapshot.internationalSeo.hreflangCount === 0 && !targetDiffers) findings.push(finding({
    id: 'overseas:international:localized-pages-opportunity', kind: 'opportunity', category: 'international', title: '为计划进入的新语言市场建立真实本地化页面', priority: 'P3', status: 'confirm', confidence: 'high',
    evidence: `当前只发现 ${snapshot.internationalSeo.htmlLang || snapshot.internationalSeo.detectedLanguage || '一种语言'} 页面，没有发现 hreflang；对当前单语言网站这是正常状态。`, why: '进入新的语言市场时，真实本地化页面能让用户和搜索系统获得与当地语言、需求和业务范围一致的内容。', action: '只有在确定新市场后，先创建完整、可独立使用的本地化页面，再为对应页面配置自引用、互返 hreflang 和各自 Canonical。',
    codeExample: '<!-- 仅在两个真实页面都已上线后添加 -->\n<link rel="alternate" hreflang="{{CURRENT_LANGUAGE}}" href="{{PAGE_URL}}" />\n<link rel="alternate" hreflang="{{ALTERNATE_LANGUAGE}}" href="{{ALTERNATE_PAGE_URL}}" />', verification: '每个真实语言页返回 200、正文语言正确、Canonical 合理，并互相声明相同语言集合。', platformConfirmation: 'Search Console 的国际页面 URL 检查与目标市场搜索表现。', rollback: '先下线错误 hreflang，再恢复语言页模板；不要删除仍有用户价值的真实页面。', limitation: '单语言网站不需要 hreflang；插件没有发现语言版本不代表业务必须扩张。',
    applicability: '仅在计划进入英语或其他新语言市场时适用；当前单语言网站无需为了工具结果创建语言页。', directResult: '新市场拥有真实可访问的本地化页面，并与其他语言版本建立明确关系。', possibleEffect: '减少搜索系统向目标地区用户展示错误语言版本的机会。', notGuaranteed: '创建语言页和 hreflang 不能保证当地收录、排名、流量或业务增长。',
  }));
  return findings;
}

function confidenceForRows(rows: number): EvidenceConfidence {
  return rows >= 30 ? 'high' : rows >= 10 ? 'medium' : 'low';
}

export function reconcileTrackingData(input: {
  projectId: string;
  currency: string;
  timezone?: string;
  analytics: AnalyticsPerformanceRow[];
  ads: SemPerformanceRow[];
  business: BusinessOutcomeRow[];
  latestRun?: TrackingTestRun;
}): TrackingReconciliationReport {
  const timezone = input.timezone || 'UTC';
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
  const maturityDays = Math.max(1, Math.min(90, Math.ceil(Math.max(0, ...input.business.map((row) => row.conversionDelayDays ?? 0)))));
  const matureDate = new Date(Date.now() - maturityDays * 86_400_000);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(matureDate);
  const matureThrough = `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}-${parts.find((part) => part.type === 'day')?.value}`;
  const dateSets = [input.analytics, input.ads, input.business]
    .filter((rows) => rows.length)
    .map((rows) => rows.map((row) => row.date).filter(validDate).sort());
  const periodStart = dateSets.length ? dateSets.map((dates) => dates[0]).filter(Boolean).sort().at(-1) ?? null : null;
  const rawEnd = dateSets.length ? dateSets.map((dates) => dates.at(-1)).filter(Boolean).sort()[0] ?? null : null;
  const periodEnd = rawEnd && rawEnd < matureThrough ? rawEnd : matureThrough;
  const periodValid = Boolean(periodStart && periodEnd && periodStart <= periodEnd);
  const inPeriod = (date: string) => !periodValid || !validDate(date) ? !periodStart : date >= periodStart! && date <= periodEnd;
  const analytics = input.analytics.filter((row) => inPeriod(row.date));
  const ads = input.ads.filter((row) => inPeriod(row.date));
  const business = input.business.filter((row) => inPeriod(row.date));
  const clicks = ads.reduce((sum, row) => sum + row.clicks, 0);
  const sessions = analytics.reduce((sum, row) => sum + row.sessions, 0);
  const analyticsKeyEvents = analytics.reduce((sum, row) => sum + row.keyEvents, 0);
  const platformConversions = ads.reduce((sum, row) => sum + row.platformConversions, 0);
  const validConversions = business.reduce((sum, row) => sum + row.validConversions, 0);
  const revenue = business.reduce((sum, row) => sum + row.revenue, 0);
  const refunds = business.reduce((sum, row) => sum + row.refunds, 0);
  const findings: OverseasDiagnosticFinding[] = [];
  const gaps: string[] = [];
  if (!input.analytics.length) gaps.push('缺少 GA4 分析 CSV，无法核对会话和关键事件。');
  if (!input.ads.length) gaps.push('缺少 Google Ads 或 Microsoft Ads 数据，无法核对点击和平台转化。');
  if (!input.business.length) gaps.push('缺少业务结果，无法确认有效线索、订单、退款和收入。');
  if (dateSets.length > 1 && !periodValid) gaps.push('各数据集没有可比较的成熟重叠日期，当前不生成跨平台差异结论。');
  const observedCurrencies = [...new Set([input.currency, ...analytics.map((row) => row.currency ?? '')].map((value) => value.trim().toUpperCase()).filter(Boolean))];
  const currencyComparable = observedCurrencies.length <= 1;
  if (!currencyComparable) gaps.push(`检测到多种货币（${observedCurrencies.join('、')}），金额不做跨来源比较；请统一币种后重新导出。`);
  const analyticsPages = new Set(analytics.map((row) => normalizeTrackingPage(row.page)).filter(Boolean));
  const adPages = new Set(ads.map((row) => normalizeTrackingPage(row.landingPage)).filter(Boolean));
  const matchedLandingPages = [...adPages].filter((page) => analyticsPages.has(page)).length;
  const adClickIds = new Set(ads.map((row) => row.clickId?.trim()).filter((value): value is string => Boolean(value)));
  const campaignCounts = new Map<string, number>();
  ads.forEach((row) => {
    const key = (row.utmCampaign || row.campaign).trim().toLocaleLowerCase();
    if (key) campaignCounts.set(key, (campaignCounts.get(key) ?? 0) + 1);
  });
  let highConfidenceRows = 0;
  let mediumConfidenceRows = 0;
  let lowConfidenceRows = 0;
  let unmatchedRows = 0;
  business.forEach((row) => {
    if (row.clickId?.trim() && adClickIds.has(row.clickId.trim())) highConfidenceRows += 1;
    else if (row.utmCampaign?.trim() && campaignCounts.get(row.utmCampaign.trim().toLocaleLowerCase()) === 1) mediumConfidenceRows += 1;
    else if (validDate(row.date) && ads.some((ad) => ad.date === row.date && (!row.utmCampaign || [ad.utmCampaign, ad.campaign].some((value) => value?.toLocaleLowerCase() === row.utmCampaign?.toLocaleLowerCase())))) lowConfidenceRows += 1;
    else unmatchedRows += 1;
  });
  if (periodValid && clicks > 0 && sessions === 0 && input.analytics.length) findings.push(finding({
    title: '广告有点击，但分析会话为零', priority: 'P1', status: 'attention', confidence: 'high', evidence: `广告点击 ${clicks}，分析会话 ${sessions}。`,
    why: '落地失败、同意状态、标签未运行或参数/会话断裂都可能让广告访问无法进入分析。', action: '先按落地页、设备和日期核对标签请求及跳转，再检查 GA4 数据流和跨域设置。',
    codeExample: "gtag('config', 'G-XXXX', { send_page_view: true });", verification: '使用带测试 UTM 的访问完成一次追踪测试，并在 GA4 DebugView/实时报告确认。', platformConfirmation: 'GA4 后台数据流、过滤器和 DebugView。', rollback: '保留原标签配置快照；新配置异常时恢复原版本。', limitation: 'Consent 拒绝、广告拦截与报表归因延迟会造成合理差异。',
  }));
  if (periodValid && analyticsKeyEvents > 0 && platformConversions > analyticsKeyEvents * 1.5) findings.push(finding({
    title: '广告平台转化高于分析关键事件', priority: 'P1', status: 'attention', confidence: confidenceForRows(input.ads.length), evidence: `分析关键事件 ${analyticsKeyEvents}，平台转化 ${platformConversions}。`,
    why: '可能存在重复标签、不同归因窗口、多个转化操作或辅助事件被设为主要目标。', action: '按转化动作拆分报表，核对每个目标的来源、计数方式和归因窗口。', verification: '同一成熟周期比较 GA4 关键事件、广告转化动作和后端唯一业务 ID 数。', platformConfirmation: '广告后台的转化操作、主要/次要设置和计数方式。', rollback: '调整目标前保存账户快照；异常时恢复原主要转化集合。', limitation: '聚合 CSV 不能逐订单证明重复归因。',
  }));
  if (periodValid && platformConversions > 0 && input.business.length && validConversions / platformConversions < 0.5) findings.push(finding({
    title: '平台转化与有效业务差距较大', priority: 'P1', status: 'attention', confidence: confidenceForRows(input.business.length), evidence: `平台转化 ${platformConversions}，有效业务 ${validConversions}。`,
    why: '自动出价可能正在学习易触发但价值较低的事件。', action: '将有效线索或成交作为业务核对层，逐步回传真实状态和价值；不要把任意按钮点击设为主要转化。', verification: '连续一个成熟成交周期比较平台转化、有效率、有效 CPA 和退款后回报。', platformConfirmation: '检查离线转化上传结果和主要转化目标。', rollback: '先以观察目标并行验证，确认稳定后再替换主要目标。', limitation: '成交延迟可能使最近周期有效率暂时偏低。',
  }));
  if (input.latestRun?.duplicateEvents.length) findings.push(finding({
    title: '现场测试观察到重复事件', priority: 'P1', status: 'attention', confidence: 'high', evidence: `重复候选：${input.latestRun.duplicateEvents.join('、')}。`,
    why: '重复事件会虚增关键事件和广告转化，并误导自动出价。', action: '检查 GTM 与硬编码是否重复发送，并使用唯一 event_id/transaction_id 做幂等去重。', codeExample: "dataLayer.push({ event: 'generate_lead', event_id: crypto.randomUUID() });", verification: '成功和失败路径各测试一次，同一业务结果只出现一个关键事件。', platformConfirmation: '在 GA4 DebugView 和广告转化诊断中确认去重。', rollback: '发布前保留旧 GTM 容器版本和代码版本。', limitation: '同名事件可能是用户真实执行了多次，需要结合操作时间线确认。',
  }));
  return {
    id: crypto.randomUUID(), projectId: input.projectId, createdAt: new Date().toISOString(), clicks, sessions, analyticsKeyEvents, platformConversions, validConversions, revenue, refunds,
    currency: input.currency || null,
    currencyComparable,
    observedCurrencies,
    period: { start: periodValid ? periodStart : null, end: periodValid ? periodEnd : null, timezone, maturityDays },
    alignment: {
      normalizedLandingPages: new Set([...analyticsPages, ...adPages]).size,
      matchedLandingPages,
      highConfidenceRows,
      mediumConfidenceRows,
      lowConfidenceRows,
      unmatchedRows,
    },
    confidence: !periodValid || !input.analytics.length || !input.ads.length
      ? 'low'
      : highConfidenceRows > 0 || matchedLandingPages > 0
        ? confidenceForRows(Math.min(analytics.length, ads.length))
        : 'low',
    findings,
    gaps,
  };
}
