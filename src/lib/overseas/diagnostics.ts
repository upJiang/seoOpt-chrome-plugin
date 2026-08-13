import type { PageSnapshot } from '../audit/types';
import type {
  AnalyticsPerformanceRow,
  AnalyticsTagSnapshot,
  BusinessOutcomeRow,
  ConsentSignalSnapshot,
  EvidenceConfidence,
  InternationalProjectSettings,
  InternationalSeoSnapshot,
  OverseasDiagnosticFinding,
  OverseasStaticSnapshot,
  SemPerformanceRow,
  TrackingChainStage,
  TrackingObservation,
  TrackingReconciliationReport,
  TrackingTestRun,
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
  const status = issues.some((item) => /无效|不一致|缺少/.test(item)) ? 'attention' : settings.targetLanguage ? 'normal' : 'confirm';
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
  const googleScripts = input.scriptUrls.filter((url) => /googletagmanager\.com|google-analytics\.com/i.test(url));
  const bingScripts = input.scriptUrls.filter((url) => /bat\.bing\.com|clarity\.ms/i.test(url));
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
  const keyEventBefore = (marker: TrackingObservation | undefined) => marker
    ? observations.some((item) => item.type === 'event' && expected.includes(item.name.toLocaleLowerCase()) && item.relativeMs <= marker.relativeMs && marker.relativeMs - item.relativeMs <= 15_000)
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
      `失败路径判断：${failedMarker ? keyEventBefore(failedMarker) ? '失败操作前 15 秒内观察到主要事件，存在误计候选。' : '失败操作前 15 秒内未观察到主要事件。' : '用户尚未标记失败操作。'} 成功路径：${successMarker ? keyEventBefore(successMarker) ? '观察到主要事件。' : '未观察到主要事件，需要复核。' : '用户尚未标记成功操作。'}`,
    ],
  };
}

function finding(input: Omit<OverseasDiagnosticFinding, 'id'>): OverseasDiagnosticFinding {
  return { id: crypto.randomUUID(), ...input };
}

export function diagnoseOverseasStatic(
  snapshot: OverseasStaticSnapshot,
  settings: InternationalProjectSettings,
): OverseasDiagnosticFinding[] {
  const findings: OverseasDiagnosticFinding[] = [];
  const googleTags = snapshot.tags.filter((item) => item.platform.startsWith('google_'));
  const bingTags = snapshot.tags.filter((item) => item.platform === 'bing_uet' || item.platform === 'microsoft_clarity');
  if (settings.useGoogleAds && !googleTags.some((item) => item.requestObserved)) findings.push(finding({
    title: '正在投放 Google Ads，但没有观察到 Google 收集请求', priority: googleTags.some((item) => item.ids.length || item.initialized) ? 'P1' : 'P0', status: 'attention', confidence: 'high',
    evidence: googleTags.some((item) => item.ids.length || item.initialized) ? '页面存在 Google 标签或初始化证据，但本次访问没有观察到收集请求。' : '页面没有识别到 GA4、GTM 或 Google Ads 标签，也没有观察到收集请求。',
    why: '广告点击和页面转化可能无法进入分析或广告学习链路，平台 CPA/ROAS 会失去可信基础。',
    action: '先确认标签覆盖所有落地页，再检查 Consent 默认状态、GTM 触发条件和请求是否被 CSP 或广告拦截器阻止。',
    codeExample: "gtag('config', 'G-XXXXXXX');\ngtag('event', 'generate_lead', { send_to: 'AW-XXXXXXX/label' });",
    verification: '使用测试流量开始一次现场追踪，确认页面浏览和主要转化各出现一次；随后到 GA4 DebugView 与 Google Ads 转化诊断确认。',
    platformConfirmation: 'GA4 数据流/DebugView、GTM Preview、Google Ads 转化操作状态与主要/次要设置。',
    rollback: '发布前导出 GTM 容器版本或保留原代码版本；异常时恢复原标签配置。',
    limitation: '广告拦截、Consent 拒绝和单次访问网络波动会使请求暂时不可见，浏览器观察不能证明平台一定没有收到其他访问的数据。',
  }));
  if (settings.useMicrosoftAds && !bingTags.some((item) => item.platform === 'bing_uet' && item.requestObserved)) findings.push(finding({
    title: '正在投放 Microsoft Ads，但没有观察到 UET 请求', priority: bingTags.some((item) => item.ids.length || item.initialized) ? 'P1' : 'P0', status: 'attention', confidence: 'high',
    evidence: bingTags.some((item) => item.ids.length || item.initialized) ? '页面存在 UET/Clarity 脚本候选，但本次访问没有观察到 UET 收集请求。' : '页面没有识别到 UET 标签或 bat.bing.com 请求。',
    why: 'Microsoft Ads 无法可靠学习主要转化，搜索词、出价与再营销判断都会受到影响。',
    action: '确认基础 UET 覆盖落地页和转化页，并检查 Tag ID、CMP 同意条件以及 SPA 页面浏览触发。Clarity 不能替代 UET 转化。',
    codeExample: "window.uetq = window.uetq || [];\nwindow.uetq.push('event', 'submit_lead', {});",
    verification: '现场测试观察到 UET 请求后，再用 Microsoft UET Tag Helper 和广告后台目标状态复核。',
    platformConfirmation: 'Microsoft Advertising 的 UET 标签、转化目标和目标状态。',
    rollback: '保留原 GTM/UET 发布版本，出现重复事件时恢复并逐个触发器排查。',
    limitation: 'Clarity 请求只证明体验分析脚本运行，不代表 UET 或 Microsoft Ads 转化已收到。',
  }));
  for (const tagSnapshot of snapshot.tags) {
    if (tagSnapshot.oldUniversalAnalytics) findings.push(finding({
      title: '页面仍包含旧版 Universal Analytics', priority: 'P1', status: 'attention', confidence: 'high', evidence: `识别到旧 UA ID：${tagSnapshot.ids.filter((id) => id.startsWith('UA-')).join('、')}。`,
      why: 'Universal Analytics 已停止标准数据处理，旧标签会制造“装了分析但没有可用数据”的错觉。', action: '移除已确认无依赖的 UA 配置，迁移到 GA4 Measurement ID，并重新定义关键事件。',
      codeExample: "gtag('config', 'G-XXXXXXX');", verification: '页面源代码不再包含 UA-*，现场观察到 GA4 page_view，并在 GA4 DebugView 确认。', platformConfirmation: 'GA4 数据流和事件列表。', rollback: '先记录旧 UA 用途和依赖；GA4 验证前不要直接删除唯一仍在使用的业务报表。', limitation: '检测到字符串不一定代表代码实际执行，仍需核对标签来源。',
    }));
    if (tagSnapshot.duplicateIds.length) findings.push(finding({
      title: `${tagSnapshot.platform} 存在重复 ID 候选`, priority: 'P1', status: 'attention', confidence: 'medium', evidence: `重复候选：${tagSnapshot.duplicateIds.join('、')}。`, why: '同一标签被多次安装可能造成页面浏览或转化重复，进而虚高转化和误导自动出价。',
      action: '逐一确认硬编码、GTM、CMS 插件和同意管理器的安装来源，只保留一个受控入口。', codeExample: "// 在 GTM Preview 中确认同一事件只触发一个 GA4/Ads 标签。",
      verification: '同一页面加载只观察到一次 page_view；同一成功业务只出现一次主要转化。', platformConfirmation: 'GA4 DebugView、GTM Preview 与广告平台转化诊断。', rollback: '停用重复来源前保存 GTM 版本或代码差异。', limitation: '页面文本中的相同 ID 可能来自配置展示而非真实执行，因此先作为候选。',
    }));
    if (tagSnapshot.hardcodedAndTagManagerCandidate) findings.push(finding({
      title: 'GTM 与硬编码 gtag 可能同时发送', priority: 'P1', status: 'confirm', confidence: 'medium', evidence: '同一页面同时识别到 GTM 容器和 GA4 Measurement ID。', why: '两种安装方式可以共存，但若都发送同一事件会造成重复。', action: '在 GTM Preview 和现场时间线中按事件核对，不要仅因两者共存就删除代码。',
      verification: '页面浏览、主要转化和购买事件分别只发送一次。', platformConfirmation: 'GTM Preview 与 GA4 DebugView。', rollback: '一次只停用一个来源，并保留原容器版本。', limitation: '共存不等于重复；必须用运行证据确认。',
    }));
  }
  if (snapshot.consent.updateSeen && !snapshot.consent.defaultSeen) findings.push(finding({
    title: '观察到 Consent 更新，但没有默认状态', priority: 'P1', status: 'attention', confidence: 'medium', evidence: snapshot.consent.explanation, why: '默认状态若在标签运行后才设置，页面可能先发送不符合预期的分析或广告请求。', action: '在任何 Google 标签初始化前设置 Consent default，再由 CMP 根据用户选择发送 update；具体合法性需由目标市场合规人员确认。',
    codeExample: "gtag('consent', 'default', { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });",
    verification: '清空站点数据后重新加载，时间线中 default 早于 config/request，用户选择后才出现 update。', platformConfirmation: 'GTM Consent Overview 和 CMP 配置。', rollback: '保存 CMP/GTM 原版本；若业务事件被阻断，恢复后重新检查触发顺序。', limitation: '插件只观察页面现场，不提供法律合规认证。',
  }));
  const lost = snapshot.clickParameters.filter((item) => item.present && item.preservedAfterRedirect === false);
  if (lost.length) findings.push(finding({
    title: '跳转后丢失广告点击或 UTM 参数', priority: 'P1', status: 'attention', confidence: 'high', evidence: `丢失参数：${lost.map((item) => item.name).join('、')}。`, why: '点击来源无法进入后续会话或业务链路，会降低广告归因与离线转化匹配率。', action: '检查 HTTP/HTTPS、主机、语言跳转和登录/结账跨域是否保留允许的查询参数，并避免把敏感数据塞进 URL。',
    codeExample: "const next = new URL('/en/landing', location.origin);\nfor (const key of ['gclid','gbraid','wbraid','msclkid','utm_source','utm_medium','utm_campaign']) { const value = new URL(location.href).searchParams.get(key); if (value) next.searchParams.set(key, value); }",
    verification: '使用虚拟测试参数访问入口，检查每次跳转和最终页面仍保留参数，再核对后端只保存业务允许的归因字段。', platformConfirmation: '广告自动标记、GA4 会话来源和离线转化上传匹配率。', rollback: '上线前记录原跳转规则；异常时恢复，并避免开放任意参数透传。', limitation: '本检查只比较当前请求与最终地址，跨页面后端保存仍需业务系统证明。',
  }));
  for (const issue of snapshot.internationalSeo.issues) findings.push(finding({
    title: issue, priority: /noindex|404|Canonical/.test(issue) ? 'P1' : 'P2', status: 'attention', confidence: snapshot.internationalSeo.languageConfidence === 'low' ? 'low' : 'medium', evidence: `页面语言 ${snapshot.internationalSeo.htmlLang || '未声明'}，目标语言 ${snapshot.internationalSeo.targetLanguage || '未设置'}，hreflang ${snapshot.internationalSeo.hreflangCount} 条。`,
    why: '搜索引擎需要明确每个语言/地区页面服务谁，以及这些页面之间是什么关系；冲突会让错误版本参与排序或被选作规范页。', action: '先确认页面实际服务语言和地区，再修正 html lang、Canonical 和 hreflang；每个可索引语言页应自引用，并与对应页互返。',
    codeExample: '<link rel="alternate" hreflang="en-US" href="https://example.com/en-us/page" />\n<link rel="alternate" hreflang="zh-CN" href="https://example.com/zh-cn/page" />',
    verification: '检查相关语言页均返回 200、可索引、Canonical 指向自身或正确规范页，并互相声明相同语言集合。', platformConfirmation: 'Google Search Console URL 检查与 Bing Webmaster Tools 抓取/索引报告。', rollback: '发布前保存旧模板；批量异常时恢复模板并重新生成 Sitemap。', limitation: '正文语言识别是候选；低置信度时必须人工确认，插件不模拟海外 IP 或当地排名。',
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
