import { describe, expect, it } from 'vitest';

import {
  classifyPageAccessError,
  isExplicitlyUnsupportedUrl,
  originPermissionPattern,
  pageStateMatchesUrl,
} from '../src/lib/page-access';

describe('page access classification', () => {
  it('does not reject a missing URL before trying activeTab collection', () => {
    expect(isExplicitlyUnsupportedUrl(undefined)).toBe(false);
    expect(isExplicitlyUnsupportedUrl('https://www.3d66.com/')).toBe(false);
    expect(isExplicitlyUnsupportedUrl('http://localhost:4173/')).toBe(false);
  });

  it('rejects browser pages and the Chrome Web Store', () => {
    expect(isExplicitlyUnsupportedUrl('chrome://settings/')).toBe(true);
    expect(isExplicitlyUnsupportedUrl('https://chromewebstore.google.com/detail/example')).toBe(true);
  });

  it('requests only the active origin instead of all websites', () => {
    expect(originPermissionPattern('https://www.3d66.com/path?a=1')).toBe('https://www.3d66.com/*');
    expect(originPermissionPattern('http://127.0.0.1:4173/path')).toBe('http://127.0.0.1/*');
  });

  it('separates permission loss, restricted pages, and scan failures', () => {
    expect(
      classifyPageAccessError(
        'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
      ),
    ).toBe('permission_required');
    expect(classifyPageAccessError('Cannot access a chrome:// URL')).toBe('unsupported');
    expect(classifyPageAccessError('PDF 页面不支持 DOM SEO 审计。')).toBe('unsupported');
    expect(classifyPageAccessError('robots.txt 请求超时')).toBe('scan_error');
  });

  it('discards restricted and ready states after the tab navigates elsewhere', () => {
    expect(pageStateMatchesUrl({ status: 'unsupported', tabId: 1, reason: 'restricted' }, 'https://example.com/')).toBe(false);
    expect(pageStateMatchesUrl({ status: 'unsupported', tabId: 1, reason: 'restricted' }, 'chrome://settings/')).toBe(true);
    expect(pageStateMatchesUrl({ status: 'ready', tabId: 1, report: { url: 'https://old.example/' } as never }, 'https://new.example/')).toBe(false);
    expect(pageStateMatchesUrl({ status: 'ready', tabId: 1, report: { url: 'https://new.example/' } as never }, 'https://new.example/')).toBe(true);
  });
});
