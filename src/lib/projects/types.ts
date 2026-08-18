import type { AuditPriority, PageType } from '../audit/types';

export type EvidenceSource =
  | 'rendered_dom'
  | 'raw_html'
  | 'http_response'
  | 'robots'
  | 'sitemap'
  | 'site_sample'
  | 'search_csv'
  | 'ads_csv'
  | 'business_csv'
  | 'user_input';

export type EvidenceConfidence = 'high' | 'medium' | 'low';
export type SearchPlatform = 'google' | 'bing' | 'baidu' | 'unknown';
export type DatasetKind = 'seo_performance' | 'sem_performance' | 'sem_creative' | 'business_outcome' | 'analytics_performance';
export type BusinessType = 'lead_generation' | 'ecommerce' | 'saas' | 'content' | 'other';
export type RemediationStatus = 'todo' | 'in_progress' | 'ready_for_retest' | 'verified' | 'observing' | 'ignored';
export type PageTemplateType = 'home' | 'article' | 'product' | 'category' | 'search' | 'tag' | 'filter' | 'pagination' | 'other';
export type SemChangeDimension = 'budget' | 'bid_strategy' | 'conversion_goal' | 'landing_page' | 'creative' | 'targeting' | 'other';

export type OverseasSearchEngine = 'google' | 'bing' | 'both';
export type OverseasSignalStatus = 'normal' | 'attention' | 'confirm' | 'unavailable' | 'untested';
export type TrackingPlatform = 'google_analytics' | 'google_tag_manager' | 'google_ads' | 'bing_uet' | 'microsoft_clarity';
export type OverseasFindingKind = 'issue' | 'opportunity';
export type OverseasMarketEvidence = 'not_observed' | 'partial' | 'established' | 'unknown';
export type OverseasCapabilityState = 'ready' | 'partial' | 'attention' | 'not_observed' | 'not_applicable' | 'unknown';
export type OverseasCapabilityId = 'search_access' | 'localization' | 'measurement' | 'advertising' | 'business_localization';
export type OverseasFindingArea = 'search_access' | 'localization' | 'measurement' | 'advertising' | 'business_localization';

export interface OverseasNormalItem {
  id: string;
  title: string;
  evidence: string;
}

export interface OverseasEvidenceGap {
  id: string;
  title: string;
  confirmed: string;
  unavailable: string;
  limitation: string;
}

export interface OverseasMarketCapability {
  id: OverseasCapabilityId;
  label: string;
  state: OverseasCapabilityState;
  conclusion: string;
  evidence: string;
  limitation: string;
  relatedFindingIds: string[];
}

export interface OverseasMarketAssessment {
  marketEvidence: OverseasMarketEvidence;
  headline: string;
  summary: string;
  capabilities: OverseasMarketCapability[];
}

export interface OtherAnalyticsSnapshot {
  platform: 'baidu_tongji' | 'microsoft_clarity';
  label: string;
  detected: boolean;
  scriptCount: number;
  requestObserved: boolean;
}

export interface InternationalProjectSettings {
  targetCountry: string;
  targetLanguage: string;
  searchEngine: OverseasSearchEngine;
  useGoogleAds: boolean;
  useMicrosoftAds: boolean;
  conversionDomains: string[];
  googleVerification?: GoogleVerificationResult;
}

export interface SearchAccessConclusion {
  id: string;
  status: OverseasSignalStatus;
  title: string;
  explanation: string;
  checked: string;
  impact: string;
  action: string;
  expectedResult: string;
  owner: '你可以自己完成' | '需要网站开发处理' | '需要运营确认' | '需要广告人员确认';
  actionTarget: 'search_access' | 'google_verification' | 'international' | 'tracking_test';
  developerMessage: string;
  confidence: EvidenceConfidence;
  technicalEvidence: string[];
}

export interface GoogleVerificationResult {
  pageUrl: string;
  result: 'accessible' | 'issue' | 'unclear';
  confirmedAt: string;
}

export interface TrackingTestConclusion {
  status: OverseasSignalStatus;
  successfulAction: 'recorded_once' | 'not_observed' | 'duplicate_candidate' | 'untested';
  failedAction: 'not_recorded' | 'recorded_candidate' | 'untested';
  messages: string[];
  technicalEvidence: string[];
}

export interface OverseasDiagnosis {
  checkedItems: string[];
  normalItems: OverseasNormalItem[];
  issues: OverseasDiagnosticFinding[];
  opportunities: OverseasDiagnosticFinding[];
  evidenceGaps: OverseasEvidenceGap[];
  marketAssessment: OverseasMarketAssessment;
  normalCount: number;
  issueCount: number;
  opportunityCount: number;
  otherAnalytics: OtherAnalyticsSnapshot[];
}

export interface OverseasSummary extends OverseasDiagnosis {
  searchAccess: SearchAccessConclusion;
  googleSearch: {
    canOpen: OverseasSignalStatus;
    canRead: OverseasSignalStatus;
    indexAllowed: OverseasSignalStatus;
    indexed: OverseasSignalStatus;
    indexedExplanation: string;
  };
  googleAnalytics: {
    tag: OverseasSignalStatus;
    initialized: OverseasSignalStatus;
    request: OverseasSignalStatus;
    platform: OverseasSignalStatus;
  };
  googleAds: {
    applicable: boolean;
    status: OverseasSignalStatus;
    explanation: string;
  };
  tracking: TrackingTestConclusion;
}

export interface TrackingChainStage {
  id: 'landing' | 'source' | 'page_view' | 'action' | 'analytics_event' | 'business_result' | 'ad_import';
  label: string;
  status: OverseasSignalStatus;
  evidence: string;
  evidenceLayer: 'page' | 'browser' | 'csv' | 'backend' | 'platform' | 'user_input';
}

export interface AnalyticsTagSnapshot {
  platform: TrackingPlatform;
  ids: string[];
  scriptCount: number;
  duplicateIds: string[];
  initialized: boolean;
  requestObserved: boolean;
  events: string[];
  oldUniversalAnalytics: boolean;
  hardcodedAndTagManagerCandidate: boolean;
}

export interface ConsentSignalSnapshot {
  found: boolean;
  defaultSeen: boolean;
  updateSeen: boolean;
  orderValid: boolean | null;
  signals: Record<string, string | null>;
  explanation: string;
}

export interface InternationalSeoSnapshot {
  status: OverseasSignalStatus;
  htmlLang: string;
  detectedLanguage: string | null;
  languageConfidence: 'high' | 'medium' | 'low';
  targetLanguage: string;
  hreflangCount: number;
  selfReference: boolean | null;
  reciprocalCandidates: number;
  xDefault: boolean;
  issues: string[];
  targets?: Array<{
    kind?: 'language' | 'mobile';
    lang: string;
    url: string;
    status: number | null;
    finalUrl: string;
    reciprocal: boolean | null;
    canonical: string;
    noindex: boolean;
    htmlLang: string;
    issue: string | null;
    issues?: InternationalTargetIssue[];
  }>;
  sitemapConsistency?: 'matched' | 'partial' | 'unavailable';
  relatedCheck?: InternationalRelatedCheck;
  regionalSignals?: {
    currencyCodes: string[];
    phoneCountryCodes: string[];
    datePatterns: string[];
  };
  checkedAt: string;
}

export type InternationalTargetIssueCode =
  | 'http_error'
  | 'noindex'
  | 'missing_lang'
  | 'invalid_lang'
  | 'target_language_mismatch'
  | 'content_language_mismatch'
  | 'invalid_hreflang'
  | 'missing_self_reference'
  | 'missing_reciprocal'
  | 'missing_canonical'
  | 'canonical_conflict'
  | 'redirect_mismatch'
  | 'language_mismatch';

export interface InternationalTargetIssue {
  code: InternationalTargetIssueCode;
  targetUrl: string;
  status: number | null;
  finalUrl: string;
  htmlLang: string;
  canonical: string;
  noindex: boolean;
  message: string;
}

export interface InternationalRelatedCheck {
  checkedAt: string;
  checkedUrls: string[];
  skippedOrigins: string[];
  status: 'complete' | 'partial' | 'not_applicable';
}

export interface OverseasStaticSnapshot {
  checkedAt: string;
  tags: AnalyticsTagSnapshot[];
  consent: ConsentSignalSnapshot;
  internationalSeo: InternationalSeoSnapshot;
  clickParameters: { name: string; present: boolean; preservedAfterRedirect: boolean | null }[];
  limitations: string[];
  otherAnalytics?: OtherAnalyticsSnapshot[];
}

export interface TrackingObservation {
  id: string;
  platform: TrackingPlatform | 'browser';
  type: 'initialization' | 'request' | 'event' | 'route' | 'consent';
  name: string;
  relativeMs: number;
  fields: {
    eventId: boolean;
    transactionId: boolean;
    value: boolean;
    currency: boolean;
    items: boolean;
    sensitiveField: boolean;
    targetId?: string;
  };
}

export interface TrackingTestRun {
  id: string;
  projectId: string;
  tabId?: number;
  origin?: string;
  startedAt: string;
  endedAt: string | null;
  goal: 'lead' | 'signup' | 'trial' | 'purchase' | 'download' | 'custom';
  customEvent?: string;
  status: 'running' | 'completed' | 'stopped' | 'expired' | 'paused';
  observations: TrackingObservation[];
  stages: TrackingChainStage[];
  duplicateEvents: string[];
  sensitiveFieldNames: string[];
  successfulActionObserved?: boolean;
  failedActionObserved?: boolean;
  limitations: string[];
}

export interface AnalyticsPerformanceRow {
  id: string;
  datasetId: string;
  projectId: string;
  date: string;
  page: string;
  source: string;
  medium: string;
  campaign: string;
  sessions: number;
  engagedSessions: number;
  users: number;
  eventName: string;
  keyEvents: number;
  revenue: number;
  currency?: string;
}

export interface TrackingReconciliationReport {
  id: string;
  projectId: string;
  createdAt: string;
  clicks: number;
  sessions: number;
  analyticsKeyEvents: number;
  platformConversions: number;
  validConversions: number;
  revenue: number;
  refunds: number;
  currency: string | null;
  currencyComparable: boolean;
  observedCurrencies: string[];
  period: {
    start: string | null;
    end: string | null;
    timezone: string;
    maturityDays: number;
  };
  alignment: {
    normalizedLandingPages: number;
    matchedLandingPages: number;
    highConfidenceRows: number;
    mediumConfidenceRows: number;
    lowConfidenceRows: number;
    unmatchedRows: number;
  };
  confidence: EvidenceConfidence;
  findings: OverseasDiagnosticFinding[];
  gaps: string[];
}

export interface OverseasDiagnosticFinding {
  id: string;
  kind: OverseasFindingKind;
  category: 'search_access' | 'international' | 'tracking';
  area?: OverseasFindingArea;
  title: string;
  priority: AuditPriority;
  status: OverseasSignalStatus;
  confidence: EvidenceConfidence;
  evidence: string;
  why: string;
  action: string;
  codeExample?: string;
  verification: string;
  platformConfirmation: string;
  rollback: string;
  limitation: string;
  applicability: string;
  directResult: string;
  possibleEffect: string;
  notGuaranteed: string;
}

export interface SearchProject {
  id: string;
  name: string;
  origin: string;
  market: string;
  timezone: string;
  currency: string;
  brandTerms: string[];
  primaryConversion: string;
  createdAt: string;
  updatedAt: string;
  international?: InternationalProjectSettings;
  sem: {
    businessType: BusinessType;
    negativeTerms: string[];
    landingTargetQuery: string;
    adPromise: string;
    targetCpa: number | null;
    targetRoas: number | null;
    grossProfitPerConversion: number | null;
  };
}

export interface PageEvaluationContext {
  expectedIndexState: 'unknown' | 'index' | 'noindex';
  pageType: PageType;
  targetQuery: string;
  pageTask: string;
  inferred: {
    expectedIndexState: boolean;
    pageType: boolean;
  };
}

export interface RootCauseGroup {
  id: string;
  title: string;
  priority: AuditPriority;
  findingIds: string[];
  affectedUrls: string[];
  evidenceSources: EvidenceSource[];
  confidence: EvidenceConfidence;
}

export type SiteAuditStatus = 'queued' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';

export interface SitePageRecord {
  id: string;
  runId: string;
  projectId: string;
  url: string;
  finalUrl: string;
  status: number | null;
  contentType: string;
  title: string;
  description: string;
  robots: string[];
  canonical: string;
  h1: string[];
  textLength: number;
  contentFingerprint: string;
  internalLinks: string[];
  hreflangs: Array<{ lang: string; href: string }>;
  inSitemap: boolean;
  allowedByRobots: boolean | null;
  redirectCount: number;
  error: string | null;
  fetchedAt: string;
  pageType?: PageTemplateType;
  templateKey?: string;
  canonicalResolved?: string;
  canonicalStatus?: number | null;
  canonicalIndexable?: boolean | null;
  isSearchPage?: boolean;
  isTagPage?: boolean;
  isFilterPage?: boolean;
  isPaginationPage?: boolean;
  paginationNumber?: number | null;
  bodyFingerprint?: string;
  nearDuplicateFingerprint?: string;
  linkDepth?: number | null;
  incomingLinkCount?: number;
  outboundLinkCount?: number;
  jsonLdTypes?: string[];
  jsonLdIssues?: string[];
  titlePattern?: string;
  language?: string;
  contentTerms?: string[];
  responseHeaders?: import('../audit/types').ResponseHeaderSnapshot;
  compressionStatus?: import('../audit/types').TechnicalSignalStatus;
  compressionExplanation?: string;
  cacheStatus?: import('../audit/types').TechnicalSignalStatus;
  cacheExplanation?: string;
  nofollowInternalCount?: number;
  nofollowExternalCount?: number;
  pageNofollow?: boolean;
  crawlerAccessStatus?: import('../audit/types').TechnicalSignalStatus;
  robotsBlockedResourceCount?: number;
}

export interface SiteAuditIssue {
  id: string;
  code: string;
  title: string;
  priority: AuditPriority;
  confidence: EvidenceConfidence;
  evidence: string;
  impact?: string;
  recommendation?: string;
  verification?: string;
  affectedUrls: string[];
  sampled: boolean;
}

export interface SiteAuditRun {
  id: string;
  projectId: string;
  origin: string;
  status: SiteAuditStatus;
  limit: 20 | 50 | 100;
  queuedUrls: string[];
  completedUrls: string[];
  blockedUrls: string[];
  pages: number;
  issues: SiteAuditIssue[];
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  inventory?: SiteInventorySummary;
  robotsSummary?: {
    status: number | null;
    agentAccess: import('../audit/robots').ParsedRobotsPolicy['agentAccess'] | null;
    syntaxIssues: string[];
    unknownDirectives: string[];
  };
  entryVariants?: import('../audit/types').RedirectVariantResult[];
}

export interface UrlPatternCluster {
  key: string;
  label: string;
  pageType: PageTemplateType;
  sampledUrls: string[];
  totalSampled: number;
  statusCounts: Record<string, number>;
  duplicateTitleCount: number;
  duplicateContentCount: number;
  noindexCount: number;
  sitemapCount: number;
}

export interface SiteInventorySummary {
  sampledPages: number;
  sitemap: { discovered: boolean; status: number | null; urlCount: number; childCount: number; invalidUrls: number; invalidLastmod: number; compressedFiles: number };
  templateClusters: UrlPatternCluster[];
  queryUrlCount: number;
  searchUrlCount: number;
  tagUrlCount: number;
  filterUrlCount: number;
  paginationUrlCount: number;
  emptyContentCount: number;
  nearDuplicateGroups: number;
  orphanCandidates: number;
  hreflangIssues: number;
  internalLinkOpportunities: InternalLinkOpportunity[];
  confidence: EvidenceConfidence;
}

export interface SchemaValidationResult {
  validSyntax: boolean;
  types: string[];
  pageType: PageTemplateType | 'unknown';
  issues: Array<{ code: string; severity: 'warning' | 'error'; message: string; field?: string }>;
  visibleMismatchFields: string[];
}

export interface InternalLinkOpportunity {
  id: string;
  sourceUrl: string;
  targetUrl: string;
  suggestedAnchor: string;
  reason: string;
  relevance: number;
  confidence: EvidenceConfidence;
}

export interface SeoOpportunity {
  id: string;
  kind: 'snippet' | 'near_win' | 'cannibalization' | 'crawl' | 'content' | 'conversion';
  title: string;
  priority: AuditPriority;
  confidence: EvidenceConfidence;
  evidence: string;
  action: string;
  affectedUrls: string[];
}

export interface ServerLogSummary {
  id: string;
  projectId: string;
  importedAt: string;
  requestCount: number;
  dateMin: string | null;
  dateMax: string | null;
  botFamilies: Array<{ family: string; requests: number; verified: false }>;
  statusCounts: Record<string, number>;
  slowUrlCandidates: Array<{ url: string; requests: number; averageMs: number | null; p95Ms: number | null }>;
  wastedUrlCandidates: Array<{ url: string; reason: string; requests: number }>;
  sitemapNeverCrawledCandidates: string[];
  privacy: 'aggregated_only';
}

export interface AuditBaseline {
  id: string;
  projectId: string;
  reportId?: string;
  siteRunId?: string;
  createdAt: string;
  overallScore: number | null;
  findingStates: Record<string, { status: string; priority: AuditPriority; evidence: string }>;
  pageSignals: Record<string, string | number | null>;
  siteIssueCount: number;
  seoSummary?: SeoPerformanceSummary | null;
}

export interface RemediationTask {
  id: string;
  projectId: string;
  rootCauseId: string;
  title: string;
  status: RemediationStatus;
  priority: AuditPriority;
  confidence: EvidenceConfidence;
  owner: 'SEO' | '开发' | '内容' | '设计' | '联合';
  effort: '低' | '中' | '高';
  evidence: string;
  why: string;
  action: string;
  codeExample?: string;
  antiPattern?: string;
  limitations?: string;
  affectedUrls: string[];
  verification: string;
  observationPeriod: string;
  rollback: string;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt?: string;
  baselineId?: string;
}

export interface ChangeRecord {
  id: string;
  projectId: string;
  taskId?: string;
  type: 'scan' | 'site_audit' | 'data_import' | 'retest' | 'status_change';
  createdAt: string;
  summary: string;
  beforeBaselineId?: string;
  afterBaselineId?: string;
  channel?: 'seo' | 'sem' | 'site' | 'data';
  semDimension?: SemChangeDimension;
  learningUntil?: string;
}

export interface ColumnMapping {
  source: string;
  target: string;
  confirmed: boolean;
}

export interface ImportDataset {
  id: string;
  projectId: string;
  kind: DatasetKind;
  platform: SearchPlatform;
  name: string;
  rowCount: number;
  mapping: ColumnMapping[];
  dateMin: string | null;
  dateMax: string | null;
  importedAt: string;
  fingerprint: string;
}

export interface SeoPerformanceRow {
  id: string;
  datasetId: string;
  projectId: string;
  platform: SearchPlatform;
  date: string;
  query: string;
  page: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number | null;
  branded: boolean;
  device?: string;
  country?: string;
  searchAppearance?: string;
}

export interface SemPerformanceRow {
  id: string;
  datasetId: string;
  projectId: string;
  platform: SearchPlatform;
  date: string;
  campaign: string;
  adGroup: string;
  keyword: string;
  searchTerm: string;
  matchType: string;
  landingPage: string;
  impressions: number;
  clicks: number;
  cost: number;
  platformConversions: number;
  conversionValue: number;
  branded: boolean;
  conversionAction?: string;
  conversionType?: 'primary' | 'observation' | 'unknown';
  campaignType?: string;
  bidStrategy?: string;
  budget?: number | null;
  device?: string;
  location?: string;
  hour?: string;
  clickId?: string;
  utmCampaign?: string;
  assetGroup?: string;
  finalUrlExpansion?: string;
}

export interface SemCreativeRow {
  id: string;
  datasetId: string;
  projectId: string;
  platform: SearchPlatform;
  campaign: string;
  adGroup: string;
  headline: string;
  description: string;
  finalUrl: string;
}

export interface BusinessOutcomeRow {
  id: string;
  datasetId: string;
  projectId: string;
  date: string;
  attributionKey: string;
  status: string;
  validConversions: number;
  revenue: number;
  refunds: number;
  grossProfit: number;
  clickId?: string;
  utmCampaign?: string;
  attributionConfidence?: EvidenceConfidence;
  conversionDelayDays?: number | null;
}

export type DiagnosticState = 'good' | 'attention' | 'risk' | 'insufficient';

export interface SemDiagnosticMetric {
  id: string;
  label: string;
  value: number | null;
  formattedValue: string;
  state: DiagnosticState;
  evidence: string;
}

export interface SemDiagnosticFinding {
  id: string;
  stage: 'tracking' | 'search_terms' | 'cost' | 'creative_landing' | 'business' | 'budget';
  title: string;
  priority: AuditPriority;
  confidence: EvidenceConfidence;
  evidence: string;
  why: string;
  action: string;
  verification: string;
  stopCandidate: boolean;
}

export interface SemDiagnosticReport {
  id: string;
  projectId: string;
  createdAt: string;
  period: { start: string | null; end: string | null; previousStart: string | null; previousEnd: string | null };
  statuses: {
    tracking: DiagnosticState;
    searchTerms: DiagnosticState;
    creativeLanding: DiagnosticState;
    conversionQuality: DiagnosticState;
    commercialSustainability: DiagnosticState;
  };
  metrics: SemDiagnosticMetric[];
  findings: SemDiagnosticFinding[];
  dataGaps: string[];
  sampleConfidence: EvidenceConfidence;
}

export interface SeoPerformanceSummary {
  rows: number;
  impressions: number;
  clicks: number;
  ctr: number;
  averagePosition: number | null;
  branded: { impressions: number; clicks: number };
  nonBranded: { impressions: number; clicks: number };
  cannibalizationCandidates: Array<{ query: string; pages: string[]; impressions: number }>;
  opportunities?: SeoOpportunity[];
  pageMatrix?: Array<{
    page: string;
    impressions: number;
    clicks: number;
    ctr: number;
    averagePosition: number | null;
    queryCount: number;
    branded: boolean;
  }>;
  queryPageConflictCount?: number;
  ctrBaselines?: Array<{ bucket: string; impressions: number; clicks: number; ctr: number }>;
  periodComparison?: {
    current: { impressions: number; clicks: number; ctr: number };
    previous: { impressions: number; clicks: number; ctr: number };
    change: { impressions: number | null; clicks: number | null; ctr: number | null };
    confidence: EvidenceConfidence;
    period: {
      days: number;
      previousStart: string;
      previousEnd: string;
      currentStart: string;
      currentEnd: string;
      maturityDays: number;
    };
    segments: {
      branded: {
        current: { impressions: number; clicks: number; ctr: number };
        previous: { impressions: number; clicks: number; ctr: number };
        change: { impressions: number | null; clicks: number | null; ctr: number | null };
      };
      nonBranded: {
        current: { impressions: number; clicks: number; ctr: number };
        previous: { impressions: number; clicks: number; ctr: number };
        change: { impressions: number | null; clicks: number | null; ctr: number | null };
      };
    };
  };
}
