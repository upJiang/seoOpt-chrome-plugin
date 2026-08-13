import { describe, expect, it } from 'vitest';

import { isMainContentRenderDependent, renderTextRatio } from '../src/lib/audit/rendering';
import { parseRobotsPolicy } from '../src/lib/audit/robots';

describe('robots.txt parsing', () => {
  it('applies the requested crawler group and extracts unique sitemaps', () => {
    const result = parseRobotsPolicy(
      'https://example.com/robots.txt',
      [
        'User-agent: *',
        'Disallow: /private/',
        'User-agent: Googlebot',
        'Allow: /private/public/',
        'Disallow: /private/',
        'Sitemap: https://example.com/sitemap.xml',
        'Sitemap: https://example.com/sitemap.xml',
      ].join('\n'),
      'https://example.com/private/public/page',
    );
    expect(result.allowed).toBe(true);
    expect(result.sitemaps).toEqual(['https://example.com/sitemap.xml']);
  });

  it('detects a blocked path', () => {
    const result = parseRobotsPolicy(
      'https://example.com/robots.txt',
      'User-agent: *\nDisallow: /private/',
      'https://example.com/private/report',
    );
    expect(result.allowed).toBe(false);
  });
});

describe('raw and rendered DOM comparison', () => {
  it('flags an indexable page whose primary text is mostly client rendered', () => {
    expect(isMainContentRenderDependent({
      available: true,
      rawTitle: '',
      rawDescription: '',
      rawRobots: [],
      rawCanonicals: [],
      rawH1: [],
      rawH1Count: 0,
      rawTextLength: 40,
      renderedTextLength: 1000,
      rawInternalLinks: [],
      rawHreflangs: [],
      rawJsonLdCount: 0,
      differences: ['正文'],
      error: null,
    }, 'index')).toBe(true);
  });

  it('does not penalize a deliberate noindex page or empty page', () => {
    const comparison = {
      available: true,
      rawTitle: '',
      rawDescription: '',
      rawRobots: [],
      rawCanonicals: [],
      rawH1: [],
      rawH1Count: 0,
      rawTextLength: 10,
      renderedTextLength: 1000,
      rawInternalLinks: [],
      rawHreflangs: [],
      rawJsonLdCount: 0,
      differences: ['正文'],
      error: null,
    };
    expect(isMainContentRenderDependent(comparison, 'noindex')).toBe(false);
    expect(renderTextRatio(0, 0)).toBeNull();
  });
});
