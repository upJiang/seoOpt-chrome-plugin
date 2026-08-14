import { buildAuditReport } from '../src/lib/audit/rules';
import {
  type AuditContext,
  type AiConversation,
  type PageSnapshot,
  type RedirectVariantResult,
  type RuntimeMessage,
  type ScanState,
} from '../src/lib/audit/types';
import {
  assessCache,
  assessCompression,
  buildSiteEntryUrls,
  collectResponseHeaders,
  evaluateTransport,
} from '../src/lib/audit/technical';
import {
  getProjectByOrigin,
  getProject,
  getProjectRows,
  getTrackingRun,
  getSitePages,
  latestSiteRun,
  listAuditBaselines,
  listRemediationTasks,
  saveAuditBaseline,
  saveChangeRecord,
  saveRemediationTask,
  saveSitePages,
  saveSiteRun,
  saveLogSummary,
  deleteRemediationTask,
  deleteTrackingRun,
  latestOverseasReport,
  listTrackingRuns,
  listRunningTrackingRunsForTab,
  saveOverseasReport,
  saveTrackingRun,
} from '../src/lib/projects/db';
import type { InternationalProjectSettings, OverseasStaticSnapshot, TrackingObservation, TrackingTestRun } from '../src/lib/projects/types';
import { finalizeTrackingRun, reconcileTrackingData, validateTrackingObservation } from '../src/lib/overseas/diagnostics';
import { installTrackingObserver, stopTrackingObserver } from '../src/lib/overseas/observer-main';
import { baselineFromReport } from '../src/lib/remediation/tasks';
import {
  classifyPageAccessError,
  isExplicitlyUnsupportedUrl,
  originPermissionPattern,
  pageStateMatchesUrl,
  PAGE_PERMISSION_MESSAGE,
  UNSUPPORTED_PAGE_MESSAGE,
} from '../src/lib/page-access';
import {
  clearAiKey,
  clearAiConversation,
  clearAllAiConversations,
  ensureAiConversation,
  getAiKey,
  getAiConversation,
  hasAiKey,
  getPreferences,
  getScanState,
  refreshExistingAiConversation,
  setAiKey,
  setAiConversation,
  setPreferences,
  setScanState,
} from '../src/lib/storage';

let activeAiRequest: { requestId: string; controller: AbortController } | null = null;
const activeSiteAudits = new Map<string, AbortController>();
const activeTrackingRuns = new Map<string, TrackingTestRun>();
const trackingRunMutationQueues = new Map<string, Promise<unknown>>();

const DEFAULT_INTERNATIONAL_SETTINGS: InternationalProjectSettings = {
  targetCountry: '',
  targetLanguage: '',
  searchEngine: 'both',
  useGoogleAds: false,
  useMicrosoftAds: false,
  conversionDomains: [],
};

function collectMainTrackingState(): { dataLayerEntries: unknown[]; uetEntries: unknown[] } {
  const root = window as unknown as Record<string, unknown>;
  const safeEntries = (input: unknown): unknown[] => Array.isArray(input) ? input.slice(-100).flatMap((entry) => {
    const arrayLike = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const first = Array.isArray(entry) ? entry[0] : arrayLike[0];
    const second = Array.isArray(entry) ? entry[1] : arrayLike[1];
    const third = Array.isArray(entry) ? entry[2] : arrayLike[2];
    if (typeof first === 'string') {
      const allowedSignals = ['analytics_storage', 'ad_storage', 'ad_user_data', 'ad_personalization'];
      const values = third && typeof third === 'object'
        ? Object.fromEntries(allowedSignals.map((key) => [key, typeof (third as Record<string, unknown>)[key] === 'string' ? String((third as Record<string, unknown>)[key]).slice(0, 24) : null]))
        : {};
      return [[first.slice(0, 40), typeof second === 'string' ? second.slice(0, 100) : '', values]];
    }
    if (entry && typeof entry === 'object') {
      const event = (entry as Record<string, unknown>).event;
      return typeof event === 'string' ? [{ event: event.slice(0, 100) }] : [];
    }
    return [];
  }) : [];
  return { dataLayerEntries: safeEntries(root.dataLayer), uetEntries: safeEntries(root.uetq) };
}

async function collectOverseasForTab(tabId: number, snapshot: PageSnapshot, settings: InternationalProjectSettings) {
  const execution = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'MAIN',
    func: collectMainTrackingState,
  });
  const main = execution[0]?.result ?? { dataLayerEntries: [], uetEntries: [] };
  const response = await chrome.tabs.sendMessage(tabId, {
    type: 'COLLECT_OVERSEAS_STATIC', snapshot, settings,
    dataLayerEntries: main.dataLayerEntries,
    uetEntries: main.uetEntries,
  } satisfies RuntimeMessage) as { ok: boolean; overseas?: PageSnapshot['overseas']; error?: string };
  if (!response.ok || !response.overseas) throw new Error(response.error || '无法读取海外站静态证据。');
  return response.overseas;
}

async function fetchWithProbeTimeout(url: string, redirect: RequestRedirect): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    return await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      redirect,
      signal: controller.signal,
      headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function checkInternationalRelatedPages(snapshot: PageSnapshot): Promise<OverseasStaticSnapshot | null> {
  if (!snapshot.overseas) return null;
  const { parseHreflangTargetHtml } = await import('../src/lib/overseas/hreflang-parser');
  const currentUrl = snapshot.url;
  const currentOrigin = new URL(currentUrl).origin;
  const candidates = [
    ...snapshot.hreflangs.filter((item) => item.valid).map((item) => ({ kind: 'language' as const, lang: item.lang, href: item.href })),
    ...(snapshot.alternatePages ?? []).filter((item) => item.kind === 'mobile').map((item) => ({ kind: 'mobile' as const, lang: '移动版', href: item.href })),
  ];
  const targets = [...new Map(candidates.flatMap((target) => {
    try {
      const url = new URL(target.href, currentUrl).href;
      return [[url, { ...target, href: url }] as const];
    } catch {
      return [];
    }
  })).values()].slice(0, 20);
  const checkable: typeof targets = [];
  const skippedOrigins = new Set<string>();
  for (const target of targets) {
    const origin = new URL(target.href).origin;
    const allowed = origin === currentOrigin || await chrome.permissions.contains({ origins: [originPermissionPattern(origin)] });
    if (allowed) checkable.push(target);
    else skippedOrigins.add(origin);
  }
  const checkedTargets = await Promise.all(checkable.map(async (target) => {
    try {
      const response = await fetchWithProbeTimeout(target.href, 'follow');
      const html = (await response.text()).slice(0, 2_000_000);
      const parsed = parseHreflangTargetHtml(html, response.url || target.href, currentUrl);
      const typeLabel = target.kind === 'mobile' ? '移动版本' : '语言页';
      const issue = !response.ok
        ? `${typeLabel}返回 ${response.status}`
        : parsed.noindex
          ? `${typeLabel}设置了 noindex`
          : !parsed.htmlLang
            ? `${typeLabel}缺少 html lang`
            : target.kind === 'language' && !parsed.reciprocal
              ? '没有观察到返回当前页的 hreflang'
              : !parsed.canonical
                ? `${typeLabel}缺少 Canonical`
                : null;
      return { kind: target.kind, lang: target.lang, url: target.href, status: response.status, finalUrl: response.url, reciprocal: target.kind === 'language' ? parsed.reciprocal : null, canonical: parsed.canonical, noindex: parsed.noindex, htmlLang: parsed.htmlLang, issue };
    } catch (error) {
      return { kind: target.kind, lang: target.lang, url: target.href, status: null, finalUrl: '', reciprocal: null, canonical: '', noindex: false, htmlLang: '', issue: error instanceof Error ? error.message : '关联版本检查失败' };
    }
  }));
  const languageTargets = targets.filter((target) => target.kind === 'language');
  const sitemapUrl = snapshot.siteProbe.sitemap?.url;
  let sitemapConsistency: 'matched' | 'partial' | 'unavailable' = 'unavailable';
  if (sitemapUrl && languageTargets.length) {
    try {
      const response = await fetchWithProbeTimeout(sitemapUrl, 'follow');
      const xml = (await response.text()).slice(0, 2_000_000);
      const normalize = (value: string) => { try { const url = new URL(value); url.hash = ''; return url.href.replace(/\/$/, ''); } catch { return value; } };
      const present = languageTargets.filter((target) => xml.includes(normalize(target.href))).length;
      sitemapConsistency = present === languageTargets.length ? 'matched' : 'partial';
    } catch {
      sitemapConsistency = 'unavailable';
    }
  }
  const checkedAt = new Date().toISOString();
  return {
    ...snapshot.overseas,
    internationalSeo: {
      ...snapshot.overseas.internationalSeo,
      targets: checkedTargets,
      sitemapConsistency,
      relatedCheck: {
        checkedAt,
        checkedUrls: checkable.map((target) => target.href),
        skippedOrigins: [...skippedOrigins],
        status: targets.length === 0 ? 'not_applicable' : skippedOrigins.size ? 'partial' : 'complete',
      },
    },
  };
}

async function probeRedirectVariant(requestedUrl: string): Promise<RedirectVariantResult> {
  const chain: RedirectVariantResult['chain'] = [];
  const visited = new Set<string>();
  let current = requestedUrl;
  try {
    for (let index = 0; index <= 8; index += 1) {
      if (visited.has(current)) return { requestedUrl, finalUrl: current, status: null, redirectCount: chain.length, chain, chainComplete: true, error: '检测到循环跳转' };
      visited.add(current);
      const response = await fetchWithProbeTimeout(current, 'manual');
      if (response.type === 'opaqueredirect' || response.status === 0) {
        const followed = await fetchWithProbeTimeout(requestedUrl, 'follow');
        await followed.body?.cancel().catch(() => undefined);
        return { requestedUrl, finalUrl: followed.url || requestedUrl, status: followed.status || null, redirectCount: followed.url && followed.url !== requestedUrl ? 1 : 0, chain, chainComplete: false, error: null };
      }
      const location = response.headers.get('location');
      chain.push({ url: current, status: response.status, location });
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 300 && response.status < 400 && location) {
        current = new URL(location, current).href;
        continue;
      }
      return { requestedUrl, finalUrl: response.url || current, status: response.status, redirectCount: Math.max(0, chain.length - 1), chain, chainComplete: true, error: null };
    }
    return { requestedUrl, finalUrl: current, status: null, redirectCount: chain.length, chain, chainComplete: true, error: '跳转超过 8 次' };
  } catch (error) {
    return { requestedUrl, finalUrl: current, status: null, redirectCount: chain.length, chain, chainComplete: chain.length > 0, error: error instanceof Error ? error.message : '入口请求失败' };
  }
}

async function enrichResourceHeaders(report: import('../src/lib/audit/types').AuditReport): Promise<import('../src/lib/audit/types').ResourceSnapshot[]> {
  const technical = report.snapshot.technical;
  if (!technical) return [];
  const origin = new URL(report.url).origin;
  const candidates = technical.resources.resources.filter((item) => {
    if (item.inline || !item.url || (item.kind !== 'script' && item.kind !== 'stylesheet')) return false;
    try { return new URL(item.url).origin === origin; } catch { return false; }
  }).slice(0, 12);
  const enriched = new Map<string, import('../src/lib/audit/types').ResourceSnapshot>();
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const batch = candidates.slice(offset, offset + 4);
    const results = await Promise.all(batch.map(async (item) => {
      try {
        const response = await fetchWithProbeTimeout(item.url, 'follow');
        const headers = collectResponseHeaders(response.headers);
        const contentType = response.headers.get('content-type') || (item.kind === 'script' ? 'application/javascript' : 'text/css');
        await response.body?.cancel().catch(() => undefined);
        return { ...item, contentType, headers, compression: assessCompression(contentType, headers, item.decodedBodySize), cache: assessCache(response.url || item.url, contentType, headers) };
      } catch {
        return item;
      }
    }));
    results.forEach((item) => enriched.set(item.url, item));
  }
  return technical.resources.resources.map((item) => enriched.get(item.url) || item);
}

async function completeTechnicalProbe(report: import('../src/lib/audit/types').AuditReport): Promise<import('../src/lib/audit/types').AuditReport> {
  if (!report.snapshot.technical) throw new Error('当前报告没有技术交付证据，请先重新扫描页面。');
  const entryUrls = buildSiteEntryUrls(report.url);
  if (!entryUrls.length) throw new Error('当前地址是本机、IP 或无法识别的域名，不适用 www/非 www 入口检查。');
  const variants = await Promise.all(entryUrls.map(probeRedirectVariant));
  const resourceItems = await enrichResourceHeaders(report);
  const current = report.snapshot.technical;
  const technical = {
    ...current,
    checkedAt: new Date().toISOString(),
    transport: evaluateTransport({
      url: report.snapshot.siteProbe.page.finalUrl || report.url,
      preferredHost: current.transport.preferredHost,
      hsts: current.transport.hsts,
      mixedContentUrls: current.transport.mixedContentUrls,
      variants,
    }),
    resources: {
      ...current.resources,
      resources: resourceItems,
    },
  };
  const next = buildAuditReport({ ...report.snapshot, technical }, report.tabId, report.context);
  next.id = report.id;
  next.createdAt = report.createdAt;
  next.stale = report.stale;
  await saveState(report.tabId, { status: 'ready', tabId: report.tabId, report: next });
  try {
    const project = await getProjectByOrigin(new URL(next.url).origin);
    if (project) {
      const { refreshProjectAiConversation } = await import('../src/lib/storage');
      await refreshProjectAiConversation(next, project);
    } else {
      await refreshExistingAiConversation(next);
    }
  } catch {
    // A saved audit result remains valid even if an older AI conversation cannot be refreshed.
  }
  return next;
}

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

async function notifyState(tabId: number): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'SCAN_STATE_CHANGED', tabId } satisfies RuntimeMessage);
  } catch {
    // The side panel may not be mounted yet. State remains available in session storage.
  }
}

async function saveState(tabId: number, state: ScanState): Promise<void> {
  await setScanState(tabId, state);
  await notifyState(tabId);
}

async function notifyTrackingRun(run: TrackingTestRun): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'TRACKING_TEST_CHANGED', projectId: run.projectId, run } satisfies RuntimeMessage);
  } catch {
    // The side panel may be closed; the run is persisted before notification.
  }
}

async function storedRunningTest(projectId: string, tabId?: number): Promise<TrackingTestRun | undefined> {
  const memory = [...activeTrackingRuns.values()].find((run) => run.projectId === projectId && (tabId === undefined || run.tabId === tabId));
  if (memory) return memory;
  const stored = (await listTrackingRuns(projectId)).find((run) => run.status === 'running' && (tabId === undefined || run.tabId === tabId));
  if (!stored) return undefined;
  if (Date.now() - Date.parse(stored.startedAt) >= 600_000) {
    const expired = finalizeTrackingRun({ ...stored, status: 'expired' });
    await saveTrackingRun(expired);
    return expired;
  }
  activeTrackingRuns.set(stored.id, stored);
  return stored;
}

async function mutateTrackingRun<T>(
  runId: string,
  mutation: (run: TrackingTestRun) => { next?: TrackingTestRun; result: T },
): Promise<T | null> {
  const previous = trackingRunMutationQueues.get(runId) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
    const current = activeTrackingRuns.get(runId) ?? await getTrackingRun(runId);
    if (!current) return null;
    const { next, result } = mutation(current);
    if (!next) return result;
    if (next.status === 'running') activeTrackingRuns.set(next.id, next);
    else activeTrackingRuns.delete(next.id);
    await saveTrackingRun(next);
    await notifyTrackingRun(next);
    return result;
  });
  trackingRunMutationQueues.set(runId, task);
  try {
    return await task;
  } finally {
    if (trackingRunMutationQueues.get(runId) === task) trackingRunMutationQueues.delete(runId);
  }
}

async function persistReportWork(projectId: string, report: import('../src/lib/audit/types').AuditReport): Promise<void> {
  const baselines = await listAuditBaselines(projectId);
  const now = new Date().toISOString();
  if (!baselines.some((baseline) => baseline.reportId === report.id)) {
    const baseline = baselineFromReport(projectId, report);
    await saveAuditBaseline(baseline);
    await saveChangeRecord({
      id: crypto.randomUUID(),
      projectId,
      type: baselines.length ? 'retest' : 'scan',
      createdAt: now,
      summary: baselines.length ? `重新验证页面，页面 SEO 基础分 ${baselines[0]?.overallScore ?? '证据不足'} → ${report.overallScore ?? '证据不足'}。` : `建立页面复测基线，页面 SEO 基础分 ${report.overallScore ?? '证据不足'}。`,
      ...(baselines[0] ? { beforeBaselineId: baselines[0].id } : {}),
      afterBaselineId: baseline.id,
    });
  }
}

async function injectAuditScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: ['audit.js'],
  });
}

async function collectFromTab(tabId: number): Promise<PageSnapshot> {
  await injectAuditScript(tabId);
  const response = (await chrome.tabs.sendMessage(tabId, {
    type: 'COLLECT_PAGE',
  } satisfies RuntimeMessage)) as { ok: boolean; snapshot?: PageSnapshot; error?: string };
  if (!response?.ok || !response.snapshot) throw new Error(response?.error || '页面采集器没有返回数据。');
  return response.snapshot;
}

async function collectAiSnippet(tabId: number): Promise<string> {
  await injectAuditScript(tabId);
  const response = (await chrome.tabs.sendMessage(tabId, {
    type: 'COLLECT_AI_SNIPPET',
  } satisfies RuntimeMessage)) as { ok: boolean; snippet?: string; error?: string };
  if (!response?.ok) throw new Error(response?.error || '无法读取 AI 所需的页面短片段。');
  return response.snippet ?? '';
}

async function scanTab(tab: chrome.tabs.Tab, context?: AuditContext): Promise<ScanState> {
  if (tab.id === undefined) {
    const unsupported: ScanState = {
      status: 'unsupported',
      tabId: null,
      reason: '无法确定当前标签页，请切回要检查的网页后重试。',
    };
    return unsupported;
  }
  if (isExplicitlyUnsupportedUrl(tab.url)) {
    const unsupported: ScanState = {
      status: 'unsupported',
      tabId: tab.id,
      reason: UNSUPPORTED_PAGE_MESSAGE,
    };
    await saveState(tab.id, unsupported);
    return unsupported;
  }

  await saveState(tab.id, {
    status: 'scanning',
    tabId: tab.id,
    startedAt: new Date().toISOString(),
  });
  try {
    const snapshot = await collectFromTab(tab.id);
    try {
      const project = await getProjectByOrigin(snapshot.origin);
      snapshot.overseas = await collectOverseasForTab(tab.id, snapshot, project?.international ?? DEFAULT_INTERNATIONAL_SETTINGS);
      snapshot.overseas = await checkInternationalRelatedPages(snapshot) ?? snapshot.overseas;
    } catch {
      // Overseas evidence is supplementary and must never block the core page scan.
    }
    const report = buildAuditReport(snapshot, tab.id, context);
    // Update the site's conversation before notifying the panel so it can render the
    // evidence-update divider immediately after a rescan.
    try {
      const project = await getProjectByOrigin(new URL(report.url).origin);
      if (project) {
        const { refreshProjectAiConversation } = await import('../src/lib/storage');
        await refreshProjectAiConversation(report, project);
        await persistReportWork(project.id, report);
      } else {
        await refreshExistingAiConversation(report);
      }
    } catch {
      // Conversation storage must never prevent the core local audit from completing.
    }
    const ready: ScanState = { status: 'ready', tabId: tab.id, report };
    await saveState(tab.id, ready);
    return ready;
  } catch (error) {
    const message = error instanceof Error ? error.message : '扫描失败';
    const failure = classifyPageAccessError(message);
    const failed: ScanState = failure === 'permission_required'
      ? { status: 'permission_required', tabId: tab.id, reason: PAGE_PERMISSION_MESSAGE }
      : failure === 'unsupported'
        ? { status: 'unsupported', tabId: tab.id, reason: UNSUPPORTED_PAGE_MESSAGE }
        : { status: 'error', tabId: tab.id, message };
    await saveState(tab.id, failed);
    return failed;
  }
}

export default defineBackground(() => {
  chrome.action.onClicked.addListener((tab) => {
    if (tab.id === undefined) return;
    // sidePanel.open must be invoked synchronously from the toolbar click. Awaiting
    // storage first would lose Chrome's user-gesture authorization.
    const openPanel = chrome.sidePanel.open({ tabId: tab.id });
    void (async () => {
      await saveState(tab.id!, {
        status: 'scanning',
        tabId: tab.id!,
        startedAt: new Date().toISOString(),
      });
      await openPanel;
      await scanTab(tab);
    })().catch(async (error: unknown) => {
        await saveState(tab.id!, {
          status: 'error',
          tabId: tab.id!,
          message: error instanceof Error ? error.message : '无法打开侧边栏。',
        });
      });
  });

  chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
    const handle = async (): Promise<unknown> => {
      if (message.type === 'GET_ACTIVE_STATE') {
        const tab = await activeTab();
        if (!tab?.id) return { status: 'idle', tabId: null } satisfies ScanState;
        const state = await getScanState(tab.id);
        if (!pageStateMatchesUrl(state, tab.url)) {
          const idle = { status: 'idle', tabId: tab.id } satisfies ScanState;
          await saveState(tab.id, idle);
          return idle;
        }
        return state;
      }
      if (message.type === 'START_SCAN') {
        const tab = await activeTab();
        if (!tab) return { status: 'unsupported', tabId: null, reason: '没有活动标签页。' } satisfies ScanState;
        const context = message.url === tab.url ? message.context : undefined;
        return scanTab(tab, context);
      }
      if (message.type === 'UPDATE_REPORT_CONTEXT') {
        const nextReport = buildAuditReport(
          { ...message.report.snapshot, visibleTextPreview: '' },
          message.report.tabId,
          message.context,
        );
        nextReport.id = message.report.id;
        nextReport.createdAt = message.report.createdAt;
        nextReport.stale = message.report.stale;
        await saveState(message.report.tabId, { status: 'ready', tabId: message.report.tabId, report: nextReport });
        const project = await getProjectByOrigin(new URL(nextReport.url).origin);
        if (project) await persistReportWork(project.id, nextReport);
        return nextReport;
      }
      if (message.type === 'CHECK_SITE_ENTRIES') {
        return completeTechnicalProbe(message.report);
      }
      if (message.type === 'PAGE_STALE') {
        const tabId = sender.tab?.id;
        if (tabId === undefined) return { ok: false };
        const state = await getScanState(tabId);
        if (state.status === 'ready' && !state.report.stale) {
          await saveState(tabId, { ...state, report: { ...state.report, stale: true } });
        }
        return { ok: true };
      }
      if (message.type === 'SHOW_OVERLAY' || message.type === 'CLEAR_OVERLAY') {
        const tab = await activeTab();
        if (!tab?.id) throw new Error('没有活动标签页。');
        return chrome.tabs.sendMessage(tab.id, message);
      }
      if (message.type === 'GET_PREFERENCES') return getPreferences();
      if (message.type === 'SAVE_PREFERENCES') {
        await setPreferences(message.preferences);
        return { ok: true };
      }
      if (message.type === 'SAVE_AI_KEY') {
        await setAiKey(message.apiKey);
        return { ok: true };
      }
      if (message.type === 'GET_AI_KEY_STATUS') {
        return { hasKey: await hasAiKey() };
      }
      if (message.type === 'CLEAR_AI_KEY') {
        await clearAiKey();
        return { ok: true };
      }
      if (message.type === 'GET_AI_CONVERSATION') {
        const project = await getProjectByOrigin(message.origin);
        return getAiConversation(message.origin, project?.id);
      }
      if (message.type === 'SAVE_AI_CONVERSATION') {
        return setAiConversation(message.conversation);
      }
      if (message.type === 'SEND_AI_MESSAGE') {
        const { requestAiChat, sanitizeAiText } = await import('../src/lib/ai');
        const preferences = await getPreferences();
        const apiKey = await getAiKey();
        const tab = await activeTab();
        if (!tab?.id || tab.id !== message.report.tabId || message.report.stale) {
          throw new Error('页面或标签已变化，请重新扫描后再继续对话。');
        }
        activeAiRequest?.controller.abort();
        const controller = new AbortController();
        activeAiRequest = { requestId: message.requestId, controller };
        try {
          const snippet = await collectAiSnippet(tab.id);
          if (controller.signal.aborted) throw new Error('AI 请求已停止。');
          const project = await getProjectByOrigin(new URL(message.report.url).origin);
          const conversation = await ensureAiConversation(message.report, snippet, project);
          if (controller.signal.aborted) throw new Error('AI 请求已停止。');
          const answer = await requestAiChat(preferences.ai, apiKey, conversation, message.content, {
            signal: controller.signal,
            onDelta: (delta) => {
              if (activeAiRequest?.requestId !== message.requestId || controller.signal.aborted) return;
              void chrome.runtime.sendMessage({
                type: 'AI_MESSAGE_DELTA',
                requestId: message.requestId,
                delta,
              } satisfies RuntimeMessage).catch(() => {
                // The side panel can close while the provider is still streaming.
              });
            },
          });
          const now = new Date().toISOString();
          const userEntry = {
            id: crypto.randomUUID(),
            role: 'user' as const,
            content: sanitizeAiText(message.content, 2_000),
            createdAt: now,
            reportId: message.report.id,
          };
          const assistantEntry = {
            id: crypto.randomUUID(),
            role: 'assistant' as const,
            content: answer,
            createdAt: now,
            reportId: message.report.id,
          };
          const saved = await setAiConversation({
            ...conversation,
            entries: [...conversation.entries, userEntry, assistantEntry],
            updatedAt: now,
          });
          return { conversation: saved, message: assistantEntry };
        } finally {
          if (activeAiRequest?.requestId === message.requestId) activeAiRequest = null;
        }
      }
      if (message.type === 'CANCEL_AI_MESSAGE') {
        if (activeAiRequest?.requestId !== message.requestId) return { cancelled: false };
        activeAiRequest.controller.abort();
        return { cancelled: true };
      }
      if (message.type === 'CLEAR_AI_CONVERSATION') {
        const project = await getProjectByOrigin(message.origin);
        await clearAiConversation(message.origin, project?.id);
        return { ok: true };
      }
      if (message.type === 'CLEAR_ALL_AI_CONVERSATIONS') {
        await clearAllAiConversations();
        return { ok: true };
      }
      if (message.type === 'START_SITE_AUDIT') {
        const { runSiteAudit } = await import('../src/lib/site-audit/scanner');
        if (activeSiteAudits.has(message.project.id)) throw new Error('当前项目的站点审计正在运行。');
        const controller = new AbortController();
        activeSiteAudits.set(message.project.id, controller);
        const existing = message.resume ? await latestSiteRun(message.project.id) : undefined;
        const existingPages = existing ? await getSitePages(existing.id) : [];
        const tab = await activeTab();
        const activeState = tab?.id === undefined ? null : await getScanState(tab.id);
        const entryVariants = activeState?.status === 'ready'
          && new URL(activeState.report.url).origin === message.project.origin
          ? activeState.report.snapshot.technical?.transport.variants
          : undefined;
        try {
          await runSiteAudit({
            projectId: message.project.id,
            origin: message.project.origin,
            ...(message.currentUrl ? { currentUrl: message.currentUrl } : {}),
            limit: message.limit,
            ...(existing && (existing.status === 'paused' || existing.status === 'failed') ? { resumeRun: existing } : {}),
            ...(existingPages.length ? { existingPages } : {}),
            ...(entryVariants?.length ? { entryVariants } : {}),
            signal: controller.signal,
            onBatch: async (run, pages) => {
              await Promise.all([saveSiteRun(run), saveSitePages(pages)]);
              if (run.status === 'completed' || run.status === 'paused' || run.status === 'failed') {
                if (run.status === 'completed') await saveChangeRecord({
                  id: crypto.randomUUID(),
                  projectId: message.project.id,
                  type: 'site_audit',
                  createdAt: new Date().toISOString(),
                  summary: `完成 ${run.pages} 个 URL 的站点审计，发现 ${run.issues.length} 组采样问题。`,
                });
              }
              try {
                await chrome.runtime.sendMessage({ type: 'SITE_AUDIT_CHANGED', projectId: message.project.id, run } satisfies RuntimeMessage);
              } catch {
                // Persisted batches allow the panel to recover after it is reopened.
              }
            },
          });
          return { completed: true };
        } finally {
          activeSiteAudits.delete(message.project.id);
        }
      }
      if (message.type === 'CANCEL_SITE_AUDIT') {
        const controller = activeSiteAudits.get(message.projectId);
        controller?.abort();
        return { cancelled: Boolean(controller) };
      }
      if (message.type === 'GET_SITE_AUDIT_ACTIVE') {
        return { active: activeSiteAudits.has(message.projectId) };
      }
      if (message.type === 'GET_REMEDIATION_TASKS') {
        return listRemediationTasks(message.projectId);
      }
      if (message.type === 'SAVE_REMEDIATION_TASK') {
        await saveRemediationTask(message.task);
        return message.task;
      }
      if (message.type === 'DELETE_REMEDIATION_TASK') {
        await deleteRemediationTask(message.taskId);
        return { ok: true };
      }
      if (message.type === 'SAVE_AUDIT_BASELINE') {
        await saveAuditBaseline(message.baseline);
        return message.baseline;
      }
      if (message.type === 'GET_AUDIT_BASELINES') {
        const { listAuditBaselines } = await import('../src/lib/projects/db');
        return listAuditBaselines(message.projectId);
      }
      if (message.type === 'IMPORT_SERVER_LOG_SUMMARY') {
        await saveLogSummary(message.summary);
        return message.summary;
      }
      if (message.type === 'GET_SERVER_LOG_SUMMARY') {
        const { latestLogSummary } = await import('../src/lib/projects/db');
        return latestLogSummary(message.projectId);
      }
      if (message.type === 'GET_OVERSEAS_STATIC') {
        const tab = await activeTab();
        if (!tab?.id || tab.id !== message.report.tabId || message.report.stale) throw new Error('页面已经变化，请重新扫描。');
        return collectOverseasForTab(tab.id, message.report.snapshot, message.settings);
      }
      if (message.type === 'CHECK_HREFLANG_TARGETS') {
        const overseas = await checkInternationalRelatedPages(message.report.snapshot);
        if (!overseas) throw new Error('当前报告没有海外页面证据，请重新扫描。');
        const state = await getScanState(message.report.tabId);
        const baseReport = state.status === 'ready' && state.report.id === message.report.id ? state.report : message.report;
        const nextReport = { ...baseReport, snapshot: { ...baseReport.snapshot, overseas } };
        await saveState(message.report.tabId, { status: 'ready', tabId: message.report.tabId, report: nextReport });
        return overseas;
      }
      if (message.type === 'START_TRACKING_TEST') {
        const project = await getProject(message.projectId);
        if (!project) throw new Error('没有找到当前海外站项目。');
        const tab = await chrome.tabs.get(message.tabId);
        if (!tab.url || new URL(tab.url).origin !== project.origin) throw new Error('当前页面不属于所选项目，请先打开该网站页面。');
        const existing = await storedRunningTest(message.projectId, message.tabId);
        if (existing?.status === 'running') throw new Error('当前页面已有追踪测试正在运行。');
        const now = new Date();
        const run: TrackingTestRun = {
          id: crypto.randomUUID(), projectId: project.id, tabId: message.tabId, origin: project.origin,
          startedAt: now.toISOString(), endedAt: null, goal: message.goal,
          ...(message.customEvent?.trim() ? { customEvent: message.customEvent.trim().slice(0, 100) } : {}),
          status: 'running', observations: [], stages: [], duplicateEvents: [], sensitiveFieldNames: [],
          successfulActionObserved: false, failedActionObserved: false,
          limitations: ['浏览器观察只能证明页面现场发生了调用或请求，不能证明分析和广告后台已确认收到。', '请求正文、表单值、Cookie、业务 ID 和完整 dataLayer 不会采集。'],
        };
        await injectAuditScript(message.tabId);
        await chrome.scripting.executeScript({ target: { tabId: message.tabId, frameIds: [0] }, world: 'MAIN', func: installTrackingObserver, args: [run.id, now.getTime() + 600_000, now.getTime()] });
        activeTrackingRuns.set(run.id, run);
        await saveTrackingRun(run);
        await notifyTrackingRun(run);
        return run;
      }
      if (message.type === 'TRACKING_OBSERVATION_BATCH') {
        const observations = message.observations.slice(0, 20)
          .map(validateTrackingObservation)
          .filter((item): item is TrackingObservation => item !== null);
        const accepted = await mutateTrackingRun(message.testId, (run) => {
          if (run.status !== 'running' || (sender.tab?.id !== undefined && run.tabId !== sender.tab.id)) return { result: 0 };
          return { next: { ...run, observations: [...run.observations, ...observations].slice(-200) }, result: observations.length };
        });
        return { accepted: accepted ?? 0 };
      }
      if (message.type === 'TRACKING_OBSERVER_STOPPED') {
        const stopped = await mutateTrackingRun(message.testId, (run) => {
          if (run.status !== 'running') return { result: false };
          const expired = Date.now() - Date.parse(run.startedAt) >= 599_000;
          return { next: finalizeTrackingRun({ ...run, status: expired ? 'expired' : 'stopped' }), result: true };
        });
        return { stopped: stopped ?? false };
      }
      if (message.type === 'MARK_TRACKING_ACTION') {
        const run = await storedRunningTest(message.projectId, message.tabId);
        if (!run || run.status !== 'running') throw new Error('当前页面没有运行中的追踪测试。');
        const next = await mutateTrackingRun(run.id, (current) => {
          if (current.status !== 'running') return { result: current };
          const marker: TrackingObservation = {
            id: crypto.randomUUID(), platform: 'browser', type: 'event', name: message.outcome === 'success' ? 'user_confirmed_success' : 'user_confirmed_failure',
            relativeMs: Math.max(0, Date.now() - Date.parse(current.startedAt)),
            fields: { eventId: false, transactionId: false, value: false, currency: false, items: false, sensitiveField: false },
          };
          const updated = { ...current, observations: [...current.observations, marker].slice(-200), ...(message.outcome === 'success' ? { successfulActionObserved: true } : { failedActionObserved: true }) };
          return { next: updated, result: updated };
        });
        if (!next || next.status !== 'running') throw new Error('当前页面没有运行中的追踪测试。');
        return next;
      }
      if (message.type === 'STOP_TRACKING_TEST') {
        const run = await storedRunningTest(message.projectId, message.tabId);
        if (!run) throw new Error('没有找到当前追踪测试。');
        try {
          await chrome.tabs.sendMessage(message.tabId, { type: 'FLUSH_TRACKING_OBSERVATIONS', testId: run.id } satisfies RuntimeMessage);
        } catch {
          // Navigation or extension reload can remove the bridge. Persisted observations remain valid.
        }
        const completed = await mutateTrackingRun(run.id, (current) => {
          if (current.status !== 'running') return { result: current };
          const updated = finalizeTrackingRun({ ...current, status: 'stopped' });
          return { next: updated, result: updated };
        });
        if (!completed) throw new Error('没有找到当前追踪测试。');
        try { await chrome.scripting.executeScript({ target: { tabId: message.tabId, frameIds: [0] }, world: 'MAIN', func: stopTrackingObserver, args: [run.id] }); } catch { /* The page may already be gone. */ }
        return completed;
      }
      if (message.type === 'GET_TRACKING_TEST') {
        return message.tabId === undefined ? listTrackingRuns(message.projectId) : (await storedRunningTest(message.projectId, message.tabId)) ?? (await listTrackingRuns(message.projectId))[0] ?? null;
      }
      if (message.type === 'CLEAR_TRACKING_HISTORY') {
        if (message.runId) await deleteTrackingRun(message.runId);
        else for (const run of await listTrackingRuns(message.projectId)) await deleteTrackingRun(run.id);
        return { ok: true };
      }
      if (message.type === 'RUN_TRACKING_RECONCILIATION') {
        const project = await getProject(message.projectId);
        if (!project) throw new Error('没有找到当前项目。');
        const [analytics, ads, business, runs] = await Promise.all([
          getProjectRows<import('../src/lib/projects/types').AnalyticsPerformanceRow>('analytics_performance', project.id),
          getProjectRows<import('../src/lib/projects/types').SemPerformanceRow>('sem_performance', project.id),
          getProjectRows<import('../src/lib/projects/types').BusinessOutcomeRow>('business_outcome', project.id),
          listTrackingRuns(project.id),
        ]);
        const overseasReport = reconcileTrackingData({ projectId: project.id, currency: project.currency, timezone: project.timezone, analytics, ads, business, ...(runs[0] ? { latestRun: runs[0] } : {}) });
        await saveOverseasReport(overseasReport);
        return overseasReport;
      }
      if (message.type === 'GET_TRACKING_RECONCILIATION') return latestOverseasReport(message.projectId);
      return null;
    };

    handle()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : '请求失败' }));
    return true;
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, updatedTab) => {
    if (changeInfo.status === 'loading') {
      void getScanState(tabId).then(async (state) => {
        if (state.status === 'ready') {
          await saveState(tabId, { ...state, report: { ...state.report, stale: true } });
          return;
        }
        if (state.status === 'unsupported' || state.status === 'error' || state.status === 'permission_required') {
          await saveState(tabId, { status: 'idle', tabId });
        }
      });
      return;
    }
    if (changeInfo.status === 'complete') {
      void (async () => {
        const tab = updatedTab.url ? updatedTab : await chrome.tabs.get(tabId);
        if (tab.url && !isExplicitlyUnsupportedUrl(tab.url)) {
          const currentState = await getScanState(tabId);
          const persistentAccess = await chrome.permissions.contains({ origins: [originPermissionPattern(tab.url)] });
          if (persistentAccess && (currentState.status !== 'ready' || currentState.report.url !== tab.url || currentState.report.stale)) {
            await scanTab(tab, currentState.status === 'ready' && currentState.report.url === tab.url ? currentState.report.context : undefined);
          } else if (!pageStateMatchesUrl(currentState, tab.url)) {
            await saveState(tabId, { status: 'idle', tabId });
          }
        }
        const persistedRuns = await listRunningTrackingRunsForTab(tabId);
        const runs = [...new Map([
          ...persistedRuns,
          ...[...activeTrackingRuns.values()].filter((run) => run.tabId === tabId && run.status === 'running'),
        ].map((run) => [run.id, run])).values()];
        for (const run of runs) {
          const project = await getProject(run.projectId);
          const trackingTab = await chrome.tabs.get(tabId);
          if (!project || !trackingTab.url) continue;
          if (Date.now() - Date.parse(run.startedAt) >= 600_000) {
            const expired = finalizeTrackingRun({ ...run, status: 'expired' });
            activeTrackingRuns.delete(run.id);
            await saveTrackingRun(expired);
            await notifyTrackingRun(expired);
            continue;
          }
          activeTrackingRuns.set(run.id, run);
          let allowed = false;
          try {
            const origin = new URL(trackingTab.url).origin;
            allowed = origin === project.origin || (project.international?.conversionDomains ?? []).some((domain) => {
              try { return new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`).origin === origin; } catch { return false; }
            });
          } catch { allowed = false; }
          if (!allowed) {
            const paused = finalizeTrackingRun({ ...run, status: 'paused' });
            activeTrackingRuns.delete(run.id);
            await saveTrackingRun(paused);
            await notifyTrackingRun(paused);
            continue;
          }
          try {
            await injectAuditScript(tabId);
            await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN', func: installTrackingObserver, args: [run.id, Date.parse(run.startedAt) + 600_000, Date.parse(run.startedAt)] });
          } catch {
            const paused = finalizeTrackingRun({ ...run, status: 'paused' });
            activeTrackingRuns.delete(run.id);
            await saveTrackingRun(paused);
            await notifyTrackingRun(paused);
          }
        }
      })();
    }
  });

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void notifyState(tabId);
  });
});
