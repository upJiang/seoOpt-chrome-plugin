import { parseHTML } from 'linkedom';

import { normalizeTrackingPage } from './diagnostics';

export function parseHreflangTargetHtml(html: string, responseUrl: string, currentUrl: string): {
  canonical: string;
  htmlLang: string;
  noindex: boolean;
  reciprocal: boolean;
} {
  const { document } = parseHTML(html);
  const canonical = document.querySelector<HTMLLinkElement>('link[rel~="canonical"][href]')?.getAttribute('href')?.trim() ?? '';
  const htmlLang = document.documentElement?.getAttribute('lang')?.trim() ?? '';
  const noindex = [...document.querySelectorAll<HTMLMetaElement>('meta[name]')]
    .some((meta) => /^(?:robots|googlebot|bingbot)$/i.test(meta.getAttribute('name')?.trim() ?? '')
      && /(?:^|[,\s])noindex(?:$|[,\s])/i.test(meta.getAttribute('content') ?? ''));
  const expected = normalizeTrackingPage(currentUrl);
  const reciprocal = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="alternate"][hreflang][href]')]
    .some((link) => {
      try { return normalizeTrackingPage(new URL(link.getAttribute('href')!, responseUrl).href) === expected; } catch { return false; }
    });
  return { canonical, htmlLang, noindex, reciprocal };
}
