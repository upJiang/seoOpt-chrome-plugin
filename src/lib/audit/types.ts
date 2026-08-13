export type AuditStatus =
  | 'pass'
  | 'warning'
  | 'failure'
  | 'informational'
  | 'not_measurable'
  | 'not_applicable';

export type AuditPriority = 'P0' | 'P1' | 'P2' | 'P3';

export type AuditCategory =
  | 'discoverability'
  | 'metadata'
  | 'content'
  | 'links'
  | 'media'
  | 'performance';

import type { EvidenceConfidence, EvidenceSource, SchemaValidationResult, SiteInventorySummary, RemediationTask } from '../projects/types';
import type { SearchProject, SemDiagnosticReport, SiteAuditRun, OverseasStaticSnapshot, TrackingObservation, TrackingTestRun, InternationalProjectSettings, TrackingReconciliationReport } from '../projects/types';

export type ExpectedIndexState = 'unknown' | 'index' | 'noindex';
export type PageType = 'auto' | 'article' | 'product_service' | 'category' | 'internal_app';
export type FindingScope = 'page' | 'site_sample' | 'search_performance';

export interface ElementLocator {
  segments: string[];
}

export interface AuditContext {
  expectedIndexState: ExpectedIndexState;
  pageType: PageType;
  targetQuery: string;
  pageTask: string;
}

export interface HeadingSnapshot {
  level: number;
  text: string;
  locator: ElementLocator;
}

export interface LinkSnapshot {
  href: string;
  rawHref: string;
  text: string;
  accessibleName: string;
  isInternal: boolean;
  isFragment: boolean;
  fragmentExists: boolean;
  rel: string[];
  context?: 'navigation' | 'main' | 'footer' | 'other';
  locator: ElementLocator;
}

export interface ImageSnapshot {
  src: string;
  alt: string | null;
  widthAttribute: number | null;
  heightAttribute: number | null;
  hasStableDimensions: boolean;
  loading: string;
  inInitialViewport: boolean;
  renderedArea: number;
  insideLink: boolean;
  role: string | null;
  locator: ElementLocator;
  normalizedAlt?: string;
  altRisk?: 'missing' | 'empty-link' | 'title-copy' | 'filename' | 'repeated' | 'context-mismatch' | null;
  nearbyText?: string;
}

export interface VideoSnapshot {
  poster: string;
  preload: string;
  hasTextFallback: boolean;
  inInitialViewport: boolean;
  locator: ElementLocator;
}

export interface JsonLdSnapshot {
  valid: boolean;
  types: string[];
  error: string | null;
  rawPreview: string;
  locator: ElementLocator;
  schema?: SchemaValidationResult;
}

export interface HreflangSnapshot {
  lang: string;
  href: string;
  valid: boolean;
  locator: ElementLocator;
}

export interface RawComparisonSnapshot {
  available: boolean;
  rawTitle: string;
  rawDescription: string;
  rawRobots: string[];
  rawCanonicals: string[];
  rawH1: string[];
  rawH1Count: number;
  rawTextLength: number;
  renderedTextLength: number;
  rawInternalLinks: string[];
  rawHreflangs: Array<{ lang: string; href: string }>;
  rawJsonLdCount: number;
  differences: string[];
  error: string | null;
}

export interface PerformanceSnapshot {
  lcp: number | null;
  cls: number | null;
  fcp: number | null;
  ttfb: number | null;
}

export type TechnicalSignalStatus = 'good' | 'attention' | 'confirm' | 'unavailable';

export interface ResponseHeaderSnapshot {
  contentEncoding: string | null;
  contentLength: number | null;
  cacheControl: string | null;
  expires: string | null;
  etag: string | null;
  lastModified: string | null;
  vary: string | null;
  age: string | null;
  strictTransportSecurity: string | null;
}

export interface RedirectHop {
  url: string;
  status: number;
  location: string | null;
}

export interface RedirectVariantResult {
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  redirectCount: number;
  chain: RedirectHop[];
  chainComplete: boolean;
  error: string | null;
}

export interface TransportSecuritySnapshot {
  status: TechnicalSignalStatus;
  currentProtocol: string;
  secureContext: boolean;
  preferredHost: string | null;
  hsts: boolean | null;
  mixedContentUrls: string[];
  variants: RedirectVariantResult[];
  certificateDetails: 'not_available';
  explanation: string;
}

export interface CompressionAssessment {
  status: TechnicalSignalStatus;
  applicable: boolean;
  encoding: string | null;
  bytes: number | null;
  explanation: string;
}

export interface CacheAssessment {
  status: TechnicalSignalStatus;
  policy: 'long_immutable' | 'revalidate' | 'private' | 'no_store' | 'unclear';
  maxAgeSeconds: number | null;
  hasValidator: boolean;
  explanation: string;
}

export interface ResourceSnapshot {
  url: string;
  contentType?: string;
  kind: 'script' | 'stylesheet' | 'font' | 'image' | 'fetch' | 'other';
  async: boolean;
  defer: boolean;
  module: boolean;
  blocking: boolean;
  inline: boolean;
  inHead: boolean;
  transferSize: number | null;
  encodedBodySize: number | null;
  decodedBodySize: number | null;
  duration: number | null;
  thirdParty: boolean;
  headers?: ResponseHeaderSnapshot;
  compression?: CompressionAssessment;
  cache?: CacheAssessment;
}

export interface ResourceAuditSummary {
  total: number;
  blockingScripts: number;
  blockingStylesheets: number;
  duplicateUrls: string[];
  thirdParty: number;
  unmeasurableSizes: number;
  transferBytes: number | null;
  resources: ResourceSnapshot[];
}

export interface LinkRelSummary {
  total: number;
  internalNofollow: number;
  externalNofollow: number;
  ugc: number;
  sponsored: number;
  pageNofollow: boolean;
}

export interface CrawlerAccessSummary {
  status: TechnicalSignalStatus;
  confidence: EvidenceConfidence;
  statusCode: number | null;
  robotsAllowed: boolean | null;
  rawHasTitle: boolean | null;
  rawHasH1: boolean | null;
  rawHasMainContent: boolean | null;
  rawHasCanonical: boolean | null;
  rawHasInternalLinks: boolean | null;
  renderDependentFields: string[];
  agentAccess?: import('./robots').ParsedRobotsPolicy['agentAccess'];
  blockedResourceCount?: number;
  robotsSyntaxIssueCount?: number;
  explanation: string;
}

export interface SchemaSuggestion {
  pageType: import('../projects/types').PageTemplateType | 'unknown';
  schemaType: string;
  reason: string;
  requiredRealFields: string[];
  optionalFields: string[];
  exampleJsonLd: string;
  warnings: string[];
}

export interface TechnicalDeliveryProbe {
  checkedAt: string;
  headers: ResponseHeaderSnapshot;
  transport: TransportSecuritySnapshot;
  compression: CompressionAssessment;
  cache: CacheAssessment;
  resources: ResourceAuditSummary;
  links: LinkRelSummary;
  crawler: CrawlerAccessSummary;
  schemaSuggestions: SchemaSuggestion[];
  limitations: string[];
}

export interface PageResponseProbe {
  status: number | null;
  finalUrl: string;
  contentType: string;
  xRobotsTag: string;
  headers?: ResponseHeaderSnapshot;
  responseBodyBytes?: number | null;
  error: string | null;
}

export interface RobotsProbe {
  status: number | null;
  url: string;
  allowed: boolean | null;
  sitemaps: string[];
  agentAccess?: import('./robots').ParsedRobotsPolicy['agentAccess'];
  syntaxIssues?: string[];
  unknownDirectives?: string[];
  blockedResources?: import('./robots').RobotsBlockedResource[];
  error: string | null;
}

export interface SitemapProbe {
  url: string;
  status: number | null;
  validXml: boolean | null;
  contentType: string;
  error: string | null;
}

export interface SiteProbeResult {
  page: PageResponseProbe;
  robots: RobotsProbe;
  sitemap: SitemapProbe | null;
}

export interface PageSnapshot {
  id: string;
  url: string;
  origin: string;
  capturedAt: string;
  titleTags: string[];
  descriptions: string[];
  robotsMeta: string[];
  canonicals: string[];
  hreflangs: HreflangSnapshot[];
  htmlLang: string;
  headings: HeadingSnapshot[];
  mainCount: number;
  formCount: number;
  ctaTexts: string[];
  visibleTextLength: number;
  visibleTextPreview: string;
  articleAuthorPresent: boolean;
  articleDatePresent: boolean;
  links: LinkSnapshot[];
  images: ImageSnapshot[];
  videos: VideoSnapshot[];
  jsonLd: JsonLdSnapshot[];
  viewportMeta: string;
  openGraphCount: number;
  twitterCardPresent: boolean;
  rawComparison: RawComparisonSnapshot;
  performance: PerformanceSnapshot;
  siteProbe: SiteProbeResult;
  limitations: string[];
  schemaValidation?: SchemaValidationResult[];
  templateType?: import('../projects/types').PageTemplateType;
  titlePattern?: string;
  technical?: TechnicalDeliveryProbe;
  overseas?: OverseasStaticSnapshot;
}

export interface AuditFinding {
  id: string;
  ruleId: string;
  category: AuditCategory;
  title: string;
  status: AuditStatus;
  priority: AuditPriority;
  points: number;
  scoreRatio: number | null;
  scoreCap?: number;
  evidence: string;
  impact: string;
  explanation: string;
  recommendation: string;
  verification: string;
  observationPeriod: string;
  effort: '低' | '中' | '高';
  owner: 'SEO' | '开发' | '内容' | '设计' | '联合';
  rollback: string;
  antiPattern?: string;
  limitations?: string;
  scope: FindingScope;
  evidenceSource: EvidenceSource;
  confidence: EvidenceConfidence;
  rootCauseId: string;
  affectedUrls: string[];
  codeExample?: string;
  locator?: ElementLocator;
}

export interface CategoryScore {
  category: AuditCategory;
  label: string;
  score: number | null;
  earnedPoints: number;
  applicablePoints: number;
  configuredPoints: number;
  issueCount: number;
}

export interface AuditReport {
  id: string;
  tabId: number;
  url: string;
  createdAt: string;
  context: AuditContext;
  overallScore: number | null;
  scoreLabel: string;
  coverage: number;
  measuredChecks: number;
  measurableChecks: number;
  categoryScores: CategoryScore[];
  findings: AuditFinding[];
  externalDataGaps: string[];
  snapshot: PageSnapshot;
  stale: boolean;
  remediationTasks?: RemediationTask[];
  baselineId?: string;
  dataQuality?: {
    confidence: EvidenceConfidence;
    missing: string[];
  };
}

export interface AiProviderSettings {
  endpoint: string;
  model: string;
}

export interface UserPreferences {
  ai: AiProviderSettings;
}

export interface AiContextFinding {
  id: string;
  ruleId: string;
  category: AuditCategory;
  categoryLabel: string;
  status: AuditStatus;
  priority: AuditPriority;
  title: string;
  points: number;
  evidence: string;
  impact: string;
  explanation: string;
  recommendation: string;
  verification: string;
  observationPeriod: string;
  effort: AuditFinding['effort'];
  owner: AuditFinding['owner'];
  rollback: string;
  antiPattern?: string;
  limitations?: string;
  codeExample?: string;
}

export interface AiContextBundle {
  version: 1;
  reportId: string;
  origin: string;
  updatedAt: string;
  page: {
    url: string;
    title: string;
    descriptions: string[];
    pageType: PageType;
    htmlLang: string;
    headings: Array<{ level: number; text: string }>;
    mainCount: number;
    formCount: number;
    ctaTexts: string[];
    visibleTextLength: number;
    canonical: string[];
    robotsMeta: string[];
    viewportMeta: string;
    openGraphCount: number;
    twitterCardPresent: boolean;
  };
  score: {
    overall: number | null;
    label: string;
    coverage: number;
    measuredChecks: number;
    measurableChecks: number;
    categories: Array<{ label: string; score: number | null; issueCount: number }>;
  };
  findings: AiContextFinding[];
  links: {
    total: number;
    internal: number;
    emptyHref: number;
    emptyText: number;
    brokenFragments: number;
  };
  media: {
    images: number;
    imagesMissingAlt: number;
    imagesWithoutStableDimensions: number;
    videos: number;
    jsonLdBlocks: number;
    invalidJsonLd: number;
    hreflangs: number;
  };
  performance: PerformanceSnapshot;
  technical?: {
    transport: { status: TechnicalSignalStatus; protocol: string; preferredHost: string | null; hsts: boolean | null; mixedContentCount: number; checkedVariants: number };
    compression: CompressionAssessment;
    cache: CacheAssessment;
    resources: { total: number; blockingScripts: number; blockingStylesheets: number; duplicateCount: number; thirdParty: number; unmeasurableSizes: number };
    links: LinkRelSummary;
    crawler: CrawlerAccessSummary;
    schemaSuggestions: Array<{ schemaType: string; reason: string; warnings: string[] }>;
    limitations: string[];
  };
  siteProbe: SiteProbeResult;
  rawComparison: RawComparisonSnapshot;
  missingData: string[];
  limitations: string[];
  visibleTextExcerpt: string;
  overseas?: {
    internationalSeo: {
      status: import('../projects/types').OverseasSignalStatus;
      htmlLang: string;
      detectedLanguage: string | null;
      targetLanguage: string;
      hreflangCount: number;
      selfReference: boolean | null;
      xDefault: boolean;
      issues: string[];
    };
    tags: Array<{
      platform: import('../projects/types').TrackingPlatform;
      idCount: number;
      duplicateIdCount: number;
      installed: boolean;
      initialized: boolean;
      requestObserved: boolean;
      eventNames: string[];
      oldUniversalAnalytics: boolean;
      mixedInstallCandidate: boolean;
    }>;
    consent: import('../projects/types').ConsentSignalSnapshot;
    clickParameters: Array<{ name: string; present: boolean; preservedAfterRedirect: boolean | null }>;
    findings: Array<{
      priority: AuditPriority;
      title: string;
      confidence: import('../projects/types').EvidenceConfidence;
      evidence: string;
      action: string;
      verification: string;
      limitation: string;
    }>;
  };
  joint?: {
    project: {
      name: string;
      origin: string;
      market: string;
      timezone: string;
      currency: string;
      brandTerms: string[];
      primaryConversion: string;
      businessBoundaries: {
        hasTargetCpa: boolean;
        hasTargetRoas: boolean;
        hasGrossProfitBoundary: boolean;
      };
    };
    siteAudit: null | {
      status: string;
      sampledPages: number;
      limit: number;
      blockedByRobots: number;
      issues: Array<{
        code: string;
        title: string;
        priority: AuditPriority;
        confidence: EvidenceConfidence;
        evidence: string;
        impact: string;
        recommendation: string;
        verification: string;
        affectedUrlCount: number;
        sampled: boolean;
      }>;
    };
    seoPerformance: null | {
      rows: number;
      impressions: number;
      clicks: number;
      ctr: number;
      averagePosition: number | null;
      brandedImpressions: number;
      nonBrandedImpressions: number;
      queryPageConflictCount: number;
      opportunityCount: number;
    };
    remediation: {
      tasks: Array<{
        rootCauseId: string;
        title: string;
        priority: AuditPriority;
        confidence: EvidenceConfidence;
        owner: string;
        effort: string;
        evidence: string;
        why: string;
        action: string;
        affectedUrlCount: number;
        verification: string;
        observationPeriod: string;
        rollback: string;
      }>;
      latestBaseline: null | { score: number | null; createdAt: string };
      previousBaseline: null | { score: number | null; createdAt: string };
    };
    serverLog: null | {
      importedAt: string;
      requestCount: number;
      dateMin: string | null;
      dateMax: string | null;
      suspectedBotRequests: number;
      errorRequests: number;
      slowUrlCount: number;
      wastedUrlCount: number;
      sitemapNeverCrawledCount: number;
      privacy: 'aggregated_only';
    };
    sem: null | {
      statuses: SemDiagnosticReport['statuses'];
      metrics: SemDiagnosticReport['metrics'];
      findings: SemDiagnosticReport['findings'];
      dataGaps: string[];
      sampleConfidence: EvidenceConfidence;
    };
    overseas: null | {
      targetCountry: string;
      targetLanguage: string;
      searchEngine: string;
      trackingRuns: number;
      latestRun: null | {
        goal: string;
        status: string;
        observationCount: number;
        duplicateEvents: string[];
        sensitiveFieldCandidateCount: number;
        successfulActionObserved: boolean;
        failedActionObserved: boolean;
      };
      reconciliation: null | {
        clicks: number;
        sessions: number;
        analyticsKeyEvents: number;
        platformConversions: number;
        validConversions: number;
        confidence: import('../projects/types').EvidenceConfidence;
        currencyComparable: boolean;
        observedCurrencies: string[];
        period: import('../projects/types').TrackingReconciliationReport['period'];
        alignment: import('../projects/types').TrackingReconciliationReport['alignment'];
        findings: Array<{ priority: AuditPriority; title: string; evidence: string; action: string; verification: string; limitation: string }>;
        gaps: string[];
      };
    };
  };
}

export type AiChatRole = 'user' | 'assistant';

export interface AiChatMessage {
  id: string;
  role: AiChatRole;
  content: string;
  createdAt: string;
  reportId: string;
}

export interface AiChatContextEvent {
  id: string;
  type: 'context_update';
  reportId: string;
  url: string;
  createdAt: string;
}

export type AiChatEntry = AiChatMessage | AiChatContextEvent;

export interface AiConversation {
  version: 1;
  origin: string;
  projectId?: string;
  context: AiContextBundle;
  entries: AiChatEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface AiChatReply {
  conversation: AiConversation;
  message: AiChatMessage;
}

export type ScanState =
  | { status: 'idle'; tabId: number | null }
  | { status: 'scanning'; tabId: number; startedAt: string }
  | { status: 'ready'; tabId: number; report: AuditReport }
  | { status: 'permission_required'; tabId: number; reason: string }
  | { status: 'unsupported'; tabId: number | null; reason: string }
  | { status: 'error'; tabId: number | null; message: string };

export type RuntimeMessage =
  | { type: 'START_SCAN'; context?: AuditContext; url?: string }
  | { type: 'OPEN_OVERSEAS_WORKSPACE'; tabId: number }
  | { type: 'UPDATE_REPORT_CONTEXT'; report: AuditReport; context: AuditContext }
  | { type: 'GET_ACTIVE_STATE' }
  | { type: 'SCAN_STATE_CHANGED'; tabId: number }
  | { type: 'PAGE_STALE'; url: string }
  | { type: 'COLLECT_PAGE' }
  | { type: 'COLLECT_AI_SNIPPET' }
  | { type: 'COLLECT_OVERSEAS_STATIC'; snapshot: PageSnapshot; settings: InternationalProjectSettings; dataLayerEntries: unknown[]; uetEntries: unknown[] }
  | { type: 'CHECK_SITE_ENTRIES'; report: AuditReport }
  | { type: 'SHOW_OVERLAY'; findings: AuditFinding[]; selectedId: string | null; scroll: boolean }
  | { type: 'CLEAR_OVERLAY' }
  | { type: 'SAVE_PREFERENCES'; preferences: UserPreferences }
  | { type: 'GET_PREFERENCES' }
  | { type: 'SAVE_AI_KEY'; apiKey: string }
  | { type: 'GET_AI_KEY_STATUS' }
  | { type: 'CLEAR_AI_KEY' }
  | { type: 'GET_AI_CONVERSATION'; origin: string }
  | { type: 'SAVE_AI_CONVERSATION'; conversation: AiConversation }
  | { type: 'SEND_AI_MESSAGE'; requestId: string; report: AuditReport; content: string }
  | { type: 'AI_MESSAGE_DELTA'; requestId: string; delta: string }
  | { type: 'CANCEL_AI_MESSAGE'; requestId: string }
  | { type: 'CLEAR_AI_CONVERSATION'; origin: string }
  | { type: 'CLEAR_ALL_AI_CONVERSATIONS' }
  | { type: 'START_SITE_AUDIT'; project: SearchProject; limit: 20 | 50 | 100; currentUrl?: string; resume?: boolean }
  | { type: 'CANCEL_SITE_AUDIT'; projectId: string }
  | { type: 'GET_SITE_AUDIT_ACTIVE'; projectId: string }
  | { type: 'SITE_AUDIT_CHANGED'; projectId: string; run: SiteAuditRun }
  | { type: 'GET_REMEDIATION_TASKS'; projectId: string }
  | { type: 'SAVE_REMEDIATION_TASK'; task: RemediationTask }
  | { type: 'DELETE_REMEDIATION_TASK'; taskId: string }
  | { type: 'SAVE_AUDIT_BASELINE'; baseline: import('../projects/types').AuditBaseline }
  | { type: 'GET_AUDIT_BASELINES'; projectId: string }
  | { type: 'IMPORT_SERVER_LOG_SUMMARY'; summary: import('../projects/types').ServerLogSummary }
  | { type: 'GET_SERVER_LOG_SUMMARY'; projectId: string }
  | { type: 'GET_OVERSEAS_STATIC'; report: AuditReport; settings: InternationalProjectSettings }
  | { type: 'CHECK_HREFLANG_TARGETS'; report: AuditReport; settings: InternationalProjectSettings }
  | { type: 'START_TRACKING_TEST'; projectId: string; tabId: number; goal: TrackingTestRun['goal']; customEvent?: string }
  | { type: 'STOP_TRACKING_TEST'; projectId: string; tabId: number }
  | { type: 'MARK_TRACKING_ACTION'; projectId: string; tabId: number; outcome: 'success' | 'failure' }
  | { type: 'GET_TRACKING_TEST'; projectId: string; tabId?: number }
  | { type: 'FLUSH_TRACKING_OBSERVATIONS'; testId: string }
  | { type: 'TRACKING_OBSERVATION_BATCH'; testId: string; observations: TrackingObservation[] }
  | { type: 'TRACKING_OBSERVER_STOPPED'; testId: string }
  | { type: 'TRACKING_TEST_CHANGED'; projectId: string; run: TrackingTestRun }
  | { type: 'CLEAR_TRACKING_HISTORY'; projectId: string; runId?: string }
  | { type: 'RUN_TRACKING_RECONCILIATION'; projectId: string }
  | { type: 'GET_TRACKING_RECONCILIATION'; projectId: string };

export const CATEGORY_CONFIG: Record<AuditCategory, { label: string; points: number }> = {
  discoverability: { label: '可发现与可索引', points: 30 },
  metadata: { label: '元信息与相关性', points: 25 },
  content: { label: '内容与语义', points: 15 },
  links: { label: '链接与抓取路径', points: 10 },
  media: { label: '媒体与结构化数据', points: 10 },
  performance: { label: '性能指标', points: 10 },
};

export const DEFAULT_CONTEXT: AuditContext = {
  expectedIndexState: 'unknown',
  pageType: 'auto',
  targetQuery: '',
  pageTask: '',
};

export const DEFAULT_PREFERENCES: UserPreferences = {
  ai: {
    endpoint: '',
    model: '',
  },
};
