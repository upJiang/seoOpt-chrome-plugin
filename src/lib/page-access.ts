export type PageAccessFailure = 'permission_required' | 'unsupported' | 'scan_error';

export function originPermissionPattern(url: string): string {
  const parsed = new URL(url);
  // Chrome match patterns cannot scope permissions to a port. The scanner still
  // enforces the full origin (including port) when deciding which URLs to fetch.
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

export function isExplicitlyUnsupportedUrl(url: string | undefined): boolean {
  if (!url) return false;
  return !/^https?:\/\//i.test(url) || /^https?:\/\/chromewebstore\.google\.com\//i.test(url);
}

export function pageStateMatchesUrl(state: import('./audit/types').ScanState, url: string | undefined): boolean {
  if (!url) return state.status === 'idle';
  if (state.status === 'ready') return state.report.url === url;
  if (state.status === 'unsupported') return isExplicitlyUnsupportedUrl(url);
  return true;
}

export function classifyPageAccessError(message: string): PageAccessFailure {
  if (
    /PDF 页面不支持|extensions gallery cannot be scripted|chromewebstore\.google\.com|(?:chrome|edge|about|devtools):\/\//i.test(
      message,
    )
  ) {
    return 'unsupported';
  }
  if (
    /Missing host permission|Cannot access contents of the page|Cannot access page|Extension manifest must request permission/i.test(
      message,
    )
  ) {
    return 'permission_required';
  }
  return 'scan_error';
}

export const UNSUPPORTED_PAGE_MESSAGE =
  '当前标签不是可检测的普通网页。支持 HTTP/HTTPS 顶层页面，不支持 Chrome 内部页、Chrome Web Store 和 PDF。';

export const PAGE_PERMISSION_MESSAGE =
  '当前页面还没有读取权限。可以只授权当前网站，也可以点击浏览器工具栏中的“SEO优化”图标临时授权。';
