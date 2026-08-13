import robotsParser from 'robots-parser';

export const SEARCH_CRAWLERS = ['*', 'Googlebot', 'Bingbot', 'Baiduspider'] as const;

export type SearchCrawler = (typeof SEARCH_CRAWLERS)[number];

export interface RobotsBlockedResource {
  url: string;
  kind: 'script' | 'stylesheet' | 'image' | 'other';
  blockedFor: SearchCrawler[];
}

export interface ParsedRobotsPolicy {
  allowed: boolean;
  sitemaps: string[];
  agentAccess: Record<SearchCrawler, boolean>;
  syntaxIssues: string[];
  unknownDirectives: string[];
  blockedResources: RobotsBlockedResource[];
}

const KNOWN_DIRECTIVES = new Set([
  'allow',
  'clean-param',
  'crawl-delay',
  'disallow',
  'host',
  'noindex',
  'request-rate',
  'sitemap',
  'user-agent',
  'visit-time',
]);

function resourceKind(url: string): RobotsBlockedResource['kind'] {
  const pathname = (() => { try { return new URL(url).pathname; } catch { return url; } })();
  if (/\.m?js(?:$|\?)/i.test(pathname)) return 'script';
  if (/\.css(?:$|\?)/i.test(pathname)) return 'stylesheet';
  if (/\.(?:avif|gif|jpe?g|png|svg|webp)(?:$|\?)/i.test(pathname)) return 'image';
  return 'other';
}

function inspectDirectives(robotsText: string): { syntaxIssues: string[]; unknownDirectives: string[] } {
  const syntaxIssues: string[] = [];
  const unknownDirectives = new Set<string>();
  let hasUserAgent = false;
  robotsText.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.replace(/\s*#.*$/, '').trim();
    if (!line) return;
    const separator = line.indexOf(':');
    if (separator <= 0) {
      syntaxIssues.push(`第 ${index + 1} 行缺少“指令: 值”格式`);
      return;
    }
    const name = line.slice(0, separator).trim().toLocaleLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === 'user-agent' && value) hasUserAgent = true;
    if (!KNOWN_DIRECTIVES.has(name)) unknownDirectives.add(name);
    if ((name === 'user-agent' || name === 'sitemap') && !value) syntaxIssues.push(`第 ${index + 1} 行 ${name} 缺少值`);
    if ((name === 'allow' || name === 'disallow') && !hasUserAgent) {
      syntaxIssues.push(`第 ${index + 1} 行 ${name} 前没有 User-agent 分组`);
    }
  });
  return { syntaxIssues: [...new Set(syntaxIssues)], unknownDirectives: [...unknownDirectives] };
}

export function parseRobotsPolicy(
  robotsUrl: string,
  robotsText: string,
  pageUrl: string,
  userAgent = 'Googlebot',
  resourceUrls: string[] = [],
): ParsedRobotsPolicy {
  const parsed = robotsParser(robotsUrl, robotsText);
  const sitemaps = robotsText
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*sitemap\s*:\s*(\S+)/i)?.[1] || '')
    .filter(Boolean);
  const agentAccess = Object.fromEntries(SEARCH_CRAWLERS.map((crawler) => [
    crawler,
    parsed.isAllowed(pageUrl, crawler) ?? true,
  ])) as Record<SearchCrawler, boolean>;
  const directiveInspection = inspectDirectives(robotsText);
  const blockedResources = [...new Set(resourceUrls)].slice(0, 200).flatMap((url) => {
    const blockedFor = SEARCH_CRAWLERS.filter((crawler) => parsed.isAllowed(url, crawler) === false);
    return blockedFor.length ? [{ url, kind: resourceKind(url), blockedFor }] : [];
  });
  return {
    allowed: parsed.isAllowed(pageUrl, userAgent) ?? true,
    sitemaps: [...new Set(sitemaps)],
    agentAccess,
    ...directiveInspection,
    blockedResources,
  };
}
