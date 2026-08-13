/**
 * Runs in the inspected page's MAIN world. Keep this function self-contained:
 * Chrome serializes it before execution, so it cannot reference module scope.
 */
export function installTrackingObserver(testId: string, expiresAt: number, runStartedAt = Date.now()): void {
  const root = window as typeof window & { __SEO_OPT_TRACKING__?: { testId: string; stop: (notify?: boolean) => void } };
  const existing = root.__SEO_OPT_TRACKING__;
  if (existing?.testId === testId) return;
  existing?.stop(false);

  const startedAt = Number.isFinite(runStartedAt) ? runStartedAt : Date.now();
  const restores: Array<() => void> = [];
  let count = 0;
  let stopped = false;

  const sensitiveKey = /(?:email|e-mail|mail|phone|mobile|telephone|name|address|邮箱|电话|手机|姓名|地址)/i;
  const targetPattern = /^(?:G|GTM|AW)-[A-Z0-9-]+$/i;
  const safeText = (value: unknown, limit = 100) => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit)
    : '';
  const recordFrom = (value: unknown): Record<string, unknown> => value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const fieldsFrom = (value: unknown, targetId = '') => {
    const keys = new Set<string>();
    const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
    const visited = new WeakSet<object>();
    while (queue.length && keys.size < 100) {
      const current = queue.shift()!;
      if (!current.value || typeof current.value !== 'object' || current.depth > 3) continue;
      if (visited.has(current.value)) continue;
      visited.add(current.value);
      const record = recordFrom(current.value);
      for (const [key, child] of Object.entries(record).slice(0, 50)) {
        keys.add(key);
        if (child && typeof child === 'object') queue.push({ value: child, depth: current.depth + 1 });
      }
    }
    const keyList = [...keys];
    return {
      eventId: keyList.some((key) => /^(?:event_id|lead_id)$/i.test(key)),
      transactionId: keyList.some((key) => /^transaction_id$/i.test(key)),
      value: keyList.some((key) => /^value$/i.test(key)),
      currency: keyList.some((key) => /^currency$/i.test(key)),
      items: keyList.some((key) => /^items$/i.test(key)),
      sensitiveField: keyList.some((key) => sensitiveKey.test(key)),
      ...(targetPattern.test(targetId) || /^\d{5,}$/.test(targetId) ? { targetId: targetId.slice(0, 40) } : {}),
    };
  };
  const emit = (platform: string, type: string, name: string, fields: ReturnType<typeof fieldsFrom>) => {
    if (stopped || count >= 200) return;
    count += 1;
    document.dispatchEvent(new CustomEvent('seo-opt:tracking-observation', {
      detail: {
        testId,
        observation: {
          id: `${testId.slice(0, 16)}-${count}`,
          platform,
          type,
          name: safeText(name) || 'unknown',
          relativeMs: Math.max(0, Date.now() - startedAt),
          fields,
        },
      },
    }));
  };
  const classifyUrl = (raw: unknown) => {
    try {
      const url = new URL(typeof raw === 'string' ? raw : raw instanceof Request ? raw.url : '', location.href);
      if (/google-analytics\.com|analytics\.google\.com/i.test(url.hostname)) {
        return { platform: 'google_analytics', name: url.searchParams.get('en') || 'collect', target: url.searchParams.get('tid') || '' };
      }
      if (/googleadservices\.com|doubleclick\.net|google\.[a-z.]+/i.test(url.hostname) && /(?:conversion|pagead)/i.test(url.pathname)) {
        return { platform: 'google_ads', name: 'conversion_request', target: url.searchParams.get('tid') || '' };
      }
      if (/bat\.bing\.com/i.test(url.hostname)) {
        return { platform: 'bing_uet', name: url.searchParams.get('ea') || 'uet_request', target: url.searchParams.get('ti') || '' };
      }
      if (/clarity\.ms/i.test(url.hostname)) return { platform: 'microsoft_clarity', name: 'clarity_request', target: '' };
    } catch {
      // Invalid or relative values that cannot be resolved are ignored.
    }
    return null;
  };
  const observeRequest = (raw: unknown) => {
    const match = classifyUrl(raw);
    if (match) emit(match.platform, 'request', match.name, fieldsFrom({}, match.target));
  };

  const wrapArrayPush = (array: unknown[], platform: string) => {
    const original = array.push;
    const wrapped = function (this: unknown[], ...items: unknown[]) {
      const entries = typeof items[0] === 'string' ? [items] : items;
      for (const item of entries) {
        const itemRecord = recordFrom(item);
        const commandEntry = Array.isArray(item)
          ? item
          : typeof itemRecord[0] === 'string'
            ? [itemRecord[0], itemRecord[1], itemRecord[2]]
            : [];
        const command = safeText(commandEntry[0]);
        const record = recordFrom(item);
        const name = command === 'event' ? safeText(commandEntry[1]) : safeText(record.event) || command || 'push';
        const target = command === 'config' ? safeText(commandEntry[1]) : safeText(record.send_to);
        emit(platform, command === 'consent' ? 'consent' : command === 'config' ? 'initialization' : 'event', name, fieldsFrom(commandEntry.length ? commandEntry[2] : item, target));
      }
      return Reflect.apply(original, this, items);
    };
    array.push = wrapped;
    restores.push(() => { if (array.push === wrapped) array.push = original; });
  };

  const dataLayer = (root as unknown as Record<string, unknown>).dataLayer;
  if (Array.isArray(dataLayer)) wrapArrayPush(dataLayer, 'google_tag_manager');
  const uetq = (root as unknown as Record<string, unknown>).uetq;
  if (Array.isArray(uetq)) wrapArrayPush(uetq, 'bing_uet');

  const originalGtag = (root as unknown as Record<string, unknown>).gtag;
  if (typeof originalGtag === 'function') {
    const wrappedGtag = function (this: unknown, ...args: unknown[]) {
      const command = safeText(args[0]);
      const name = command === 'event' ? safeText(args[1]) : command || 'gtag';
      const target = command === 'config' ? safeText(args[1]) : safeText(recordFrom(args[2]).send_to);
      emit('google_analytics', command === 'consent' ? 'consent' : command === 'config' ? 'initialization' : 'event', name, fieldsFrom(args[2], target));
      return Reflect.apply(originalGtag as (...values: unknown[]) => unknown, this, args);
    };
    (root as unknown as Record<string, unknown>).gtag = wrappedGtag;
    restores.push(() => { if ((root as unknown as Record<string, unknown>).gtag === wrappedGtag) (root as unknown as Record<string, unknown>).gtag = originalGtag; });
  }

  const originalFetch = window.fetch;
  const wrappedFetch: typeof window.fetch = function (input, init) {
    observeRequest(input);
    return Reflect.apply(originalFetch, window, [input, init] as Parameters<typeof fetch>);
  };
  window.fetch = wrappedFetch;
  restores.push(() => { if (window.fetch === wrappedFetch) window.fetch = originalFetch; });

  const originalBeacon = navigator.sendBeacon;
  const wrappedBeacon: typeof navigator.sendBeacon = function (this: Navigator, url, data) {
    observeRequest(url);
    return Reflect.apply(originalBeacon, this, [url, data]);
  };
  try {
    navigator.sendBeacon = wrappedBeacon;
    restores.push(() => { if (navigator.sendBeacon === wrappedBeacon) navigator.sendBeacon = originalBeacon; });
  } catch {
    // Some pages harden navigator methods. Other observers remain active.
  }

  const xhrUrls = new WeakMap<XMLHttpRequest, string>();
  const originalOpen = XMLHttpRequest.prototype.open;
  const wrappedOpen: typeof XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    xhrUrls.set(this, String(url));
    return Reflect.apply(originalOpen, this, [method, url, ...rest] as Parameters<typeof originalOpen>);
  };
  XMLHttpRequest.prototype.open = wrappedOpen;
  restores.push(() => { if (XMLHttpRequest.prototype.open === wrappedOpen) XMLHttpRequest.prototype.open = originalOpen; });
  const originalSend = XMLHttpRequest.prototype.send;
  const wrappedSend: typeof XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    observeRequest(xhrUrls.get(this));
    return Reflect.apply(originalSend, this, [body]);
  };
  XMLHttpRequest.prototype.send = wrappedSend;
  restores.push(() => { if (XMLHttpRequest.prototype.send === wrappedSend) XMLHttpRequest.prototype.send = originalSend; });

  const wrapHistory = (key: 'pushState' | 'replaceState') => {
    const original = history[key];
    const wrapped: History[typeof key] = function (this: History, data: unknown, unused: string, url?: string | URL | null) {
      const result = Reflect.apply(original, this, [data, unused, url]);
      emit('browser', 'route', key, fieldsFrom({}));
      return result;
    };
    history[key] = wrapped;
    restores.push(() => { if (history[key] === wrapped) history[key] = original; });
  };
  wrapHistory('pushState');
  wrapHistory('replaceState');
  const onPopState = () => emit('browser', 'route', 'popstate', fieldsFrom({}));
  addEventListener('popstate', onPopState);
  restores.push(() => removeEventListener('popstate', onPopState));

  const stop = (notify = true) => {
    if (stopped) return;
    stopped = true;
    restores.reverse().forEach((restore) => { try { restore(); } catch { /* best effort */ } });
    if (notify) document.dispatchEvent(new CustomEvent('seo-opt:tracking-stopped', { detail: { testId } }));
    if (root.__SEO_OPT_TRACKING__?.testId === testId) delete root.__SEO_OPT_TRACKING__;
  };
  root.__SEO_OPT_TRACKING__ = { testId, stop };
  window.setTimeout(stop, Math.max(0, Math.min(600_000, expiresAt - Date.now())));
  emit('browser', 'initialization', 'tracking_test_started', fieldsFrom({}));
}

export function stopTrackingObserver(testId: string): void {
  const root = window as typeof window & { __SEO_OPT_TRACKING__?: { testId: string; stop: (notify?: boolean) => void } };
  if (root.__SEO_OPT_TRACKING__?.testId === testId) root.__SEO_OPT_TRACKING__.stop();
}
