import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import type {
  AnalyticsPerformanceRow,
  BusinessOutcomeRow,
  ImportDataset,
  SearchProject,
  SemCreativeRow,
  SemDiagnosticReport,
  SemPerformanceRow,
  SeoPerformanceRow,
  AuditBaseline,
  ChangeRecord,
  RemediationTask,
  ServerLogSummary,
  SiteAuditRun,
  SitePageRecord,
  TrackingReconciliationReport,
  TrackingTestRun,
} from './types';
import { normalizeProjectOrigin } from './origin';

interface SeoOptDatabase extends DBSchema {
  projects: { key: string; value: SearchProject; indexes: { 'by-origin': string; 'by-updated': string } };
  datasets: { key: string; value: ImportDataset; indexes: { 'by-project': string; 'by-fingerprint': string } };
  seoRows: { key: string; value: SeoPerformanceRow; indexes: { 'by-project': string; 'by-dataset': string } };
  semRows: { key: string; value: SemPerformanceRow; indexes: { 'by-project': string; 'by-dataset': string } };
  creativeRows: { key: string; value: SemCreativeRow; indexes: { 'by-project': string; 'by-dataset': string } };
  businessRows: { key: string; value: BusinessOutcomeRow; indexes: { 'by-project': string; 'by-dataset': string } };
  analyticsRows: { key: string; value: AnalyticsPerformanceRow; indexes: { 'by-project': string; 'by-dataset': string } };
  siteRuns: { key: string; value: SiteAuditRun; indexes: { 'by-project': string; 'by-updated': string } };
  sitePages: { key: string; value: SitePageRecord; indexes: { 'by-project': string; 'by-run': string } };
  semReports: { key: string; value: SemDiagnosticReport; indexes: { 'by-project': string; 'by-created': string } };
  remediationTasks: { key: string; value: RemediationTask; indexes: { 'by-project': string; 'by-updated': string } };
  auditBaselines: { key: string; value: AuditBaseline; indexes: { 'by-project': string; 'by-created': string } };
  changeRecords: { key: string; value: ChangeRecord; indexes: { 'by-project': string; 'by-created': string } };
  logSummaries: { key: string; value: ServerLogSummary; indexes: { 'by-project': string; 'by-imported': string } };
  trackingRuns: { key: string; value: TrackingTestRun; indexes: { 'by-project': string; 'by-started': string } };
  overseasReports: { key: string; value: TrackingReconciliationReport; indexes: { 'by-project': string; 'by-created': string } };
}

let databasePromise: Promise<IDBPDatabase<SeoOptDatabase>> | null = null;
const projectCreationPromises = new Map<string, Promise<SearchProject>>();

function normalizeProject(project: SearchProject): SearchProject {
  return {
    ...project,
    international: {
      targetCountry: project.international?.targetCountry ?? '',
      targetLanguage: project.international?.targetLanguage ?? '',
      searchEngine: project.international?.searchEngine ?? 'both',
      useGoogleAds: project.international?.useGoogleAds ?? false,
      useMicrosoftAds: project.international?.useMicrosoftAds ?? false,
      conversionDomains: project.international?.conversionDomains ?? [],
    },
    sem: {
      ...project.sem,
      landingTargetQuery: project.sem.landingTargetQuery ?? '',
      adPromise: project.sem.adPromise ?? '',
    },
  };
}

export function getDatabase(): Promise<IDBPDatabase<SeoOptDatabase>> {
  databasePromise ??= openDB<SeoOptDatabase>('seo-opt-workbench', 3, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
      const projects = database.createObjectStore('projects', { keyPath: 'id' });
      projects.createIndex('by-origin', 'origin');
      projects.createIndex('by-updated', 'updatedAt');

      const datasets = database.createObjectStore('datasets', { keyPath: 'id' });
      datasets.createIndex('by-project', 'projectId');
      datasets.createIndex('by-fingerprint', 'fingerprint');

      for (const [name, projectIndex, datasetIndex] of [
        ['seoRows', 'projectId', 'datasetId'],
        ['semRows', 'projectId', 'datasetId'],
        ['creativeRows', 'projectId', 'datasetId'],
        ['businessRows', 'projectId', 'datasetId'],
      ] as const) {
        const store = database.createObjectStore(name, { keyPath: 'id' });
        store.createIndex('by-project', projectIndex);
        store.createIndex('by-dataset', datasetIndex);
      }

      const siteRuns = database.createObjectStore('siteRuns', { keyPath: 'id' });
      siteRuns.createIndex('by-project', 'projectId');
      siteRuns.createIndex('by-updated', 'updatedAt');
      const sitePages = database.createObjectStore('sitePages', { keyPath: 'id' });
      sitePages.createIndex('by-project', 'projectId');
      sitePages.createIndex('by-run', 'runId');
      const reports = database.createObjectStore('semReports', { keyPath: 'id' });
      reports.createIndex('by-project', 'projectId');
      reports.createIndex('by-created', 'createdAt');
      }
      if (oldVersion < 2) {
        const remediationTasks = database.createObjectStore('remediationTasks', { keyPath: 'id' });
        remediationTasks.createIndex('by-project', 'projectId');
        remediationTasks.createIndex('by-updated', 'updatedAt');
        const auditBaselines = database.createObjectStore('auditBaselines', { keyPath: 'id' });
        auditBaselines.createIndex('by-project', 'projectId');
        auditBaselines.createIndex('by-created', 'createdAt');
        const changeRecords = database.createObjectStore('changeRecords', { keyPath: 'id' });
        changeRecords.createIndex('by-project', 'projectId');
        changeRecords.createIndex('by-created', 'createdAt');
        const logSummaries = database.createObjectStore('logSummaries', { keyPath: 'id' });
        logSummaries.createIndex('by-project', 'projectId');
        logSummaries.createIndex('by-imported', 'importedAt');
      }
      if (oldVersion < 3) {
        const analyticsRows = database.createObjectStore('analyticsRows', { keyPath: 'id' });
        analyticsRows.createIndex('by-project', 'projectId');
        analyticsRows.createIndex('by-dataset', 'datasetId');
        const trackingRuns = database.createObjectStore('trackingRuns', { keyPath: 'id' });
        trackingRuns.createIndex('by-project', 'projectId');
        trackingRuns.createIndex('by-started', 'startedAt');
        const overseasReports = database.createObjectStore('overseasReports', { keyPath: 'id' });
        overseasReports.createIndex('by-project', 'projectId');
        overseasReports.createIndex('by-created', 'createdAt');
      }
    },
  });
  return databasePromise;
}

export async function saveProject(project: SearchProject): Promise<void> {
  await (await getDatabase()).put('projects', project);
}

export async function listProjects(): Promise<SearchProject[]> {
  return (await (await getDatabase()).getAll('projects'))
    .map(normalizeProject)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export async function getProject(projectId: string): Promise<SearchProject | undefined> {
  const project = await (await getDatabase()).get('projects', projectId);
  return project ? normalizeProject(project) : undefined;
}

export async function getProjectByOrigin(origin: string): Promise<SearchProject | undefined> {
  const project = await (await getDatabase()).getFromIndex('projects', 'by-origin', normalizeProjectOrigin(origin));
  return project ? normalizeProject(project) : undefined;
}

export async function createProjectForOrigin(origin: string): Promise<SearchProject> {
  const normalizedOrigin = normalizeProjectOrigin(origin);
  const pending = projectCreationPromises.get(normalizedOrigin);
  if (pending) return pending;
  const creation = (async () => {
    const database = await getDatabase();
    const transaction = database.transaction('projects', 'readwrite');
    const existing = await transaction.store.index('by-origin').get(normalizedOrigin);
    if (existing) {
      await transaction.done;
      return normalizeProject(existing);
    }
    const now = new Date().toISOString();
    const project: SearchProject = {
      id: crypto.randomUUID(),
      name: new URL(normalizedOrigin).hostname,
      origin: normalizedOrigin,
      market: '中国',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
      currency: 'CNY',
      brandTerms: [],
      primaryConversion: '',
      createdAt: now,
      updatedAt: now,
      international: {
        targetCountry: '',
        targetLanguage: '',
        searchEngine: 'both',
        useGoogleAds: false,
        useMicrosoftAds: false,
        conversionDomains: [],
      },
      sem: {
        businessType: 'lead_generation',
        negativeTerms: [],
        landingTargetQuery: '',
        adPromise: '',
        targetCpa: null,
        targetRoas: null,
        grossProfitPerConversion: null,
      },
    };
    await transaction.store.put(project);
    await transaction.done;
    return project;
  })();
  projectCreationPromises.set(normalizedOrigin, creation);
  try {
    return await creation;
  } finally {
    if (projectCreationPromises.get(normalizedOrigin) === creation) {
      projectCreationPromises.delete(normalizedOrigin);
    }
  }
}

type ImportedRow = SeoPerformanceRow | SemPerformanceRow | SemCreativeRow | BusinessOutcomeRow | AnalyticsPerformanceRow;

function rowStore(kind: ImportDataset['kind']): 'seoRows' | 'semRows' | 'creativeRows' | 'businessRows' | 'analyticsRows' {
  if (kind === 'seo_performance') return 'seoRows';
  if (kind === 'sem_performance') return 'semRows';
  if (kind === 'sem_creative') return 'creativeRows';
  if (kind === 'analytics_performance') return 'analyticsRows';
  return 'businessRows';
}

export async function saveDataset(dataset: ImportDataset, rows: ImportedRow[]): Promise<void> {
  const database = await getDatabase();
  const storeName = rowStore(dataset.kind);
  const transaction = database.transaction(['datasets', storeName], 'readwrite');
  await transaction.objectStore('datasets').put(dataset);
  const rowObjectStore = transaction.objectStore(storeName);
  for (const row of rows) await rowObjectStore.put(row as never);
  await transaction.done;
}

export async function listDatasets(projectId: string): Promise<ImportDataset[]> {
  return (await (await getDatabase()).getAllFromIndex('datasets', 'by-project', projectId))
    .sort((left, right) => Date.parse(right.importedAt) - Date.parse(left.importedAt));
}

export async function getProjectRows<T extends ImportedRow>(
  kind: ImportDataset['kind'],
  projectId: string,
): Promise<T[]> {
  return (await getDatabase()).getAllFromIndex(rowStore(kind), 'by-project', projectId) as Promise<T[]>;
}

export async function deleteDataset(dataset: ImportDataset): Promise<void> {
  const database = await getDatabase();
  const storeName = rowStore(dataset.kind);
  const transaction = database.transaction(['datasets', storeName], 'readwrite');
  const keys = await transaction.objectStore(storeName).index('by-dataset').getAllKeys(dataset.id);
  for (const key of keys) await transaction.objectStore(storeName).delete(key);
  await transaction.objectStore('datasets').delete(dataset.id);
  await transaction.done;
}

export async function saveSiteRun(run: SiteAuditRun): Promise<void> {
  await (await getDatabase()).put('siteRuns', run);
}

export async function saveSitePages(pages: SitePageRecord[]): Promise<void> {
  if (!pages.length) return;
  const transaction = (await getDatabase()).transaction('sitePages', 'readwrite');
  for (const page of pages) await transaction.store.put(page);
  await transaction.done;
}

export async function latestSiteRun(projectId: string): Promise<SiteAuditRun | undefined> {
  const runs = await (await getDatabase()).getAllFromIndex('siteRuns', 'by-project', projectId);
  return runs.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

export async function getSitePages(runId: string): Promise<SitePageRecord[]> {
  return (await getDatabase()).getAllFromIndex('sitePages', 'by-run', runId);
}

export async function saveSemReport(report: SemDiagnosticReport): Promise<void> {
  await (await getDatabase()).put('semReports', report);
}

export async function saveRemediationTask(task: RemediationTask): Promise<void> {
  await (await getDatabase()).put('remediationTasks', task);
}

export async function listRemediationTasks(projectId: string): Promise<RemediationTask[]> {
  return (await (await getDatabase()).getAllFromIndex('remediationTasks', 'by-project', projectId))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export async function deleteRemediationTask(taskId: string): Promise<void> {
  await (await getDatabase()).delete('remediationTasks', taskId);
}

export async function saveAuditBaseline(baseline: AuditBaseline): Promise<void> {
  await (await getDatabase()).put('auditBaselines', baseline);
}

export async function listAuditBaselines(projectId: string): Promise<AuditBaseline[]> {
  return (await (await getDatabase()).getAllFromIndex('auditBaselines', 'by-project', projectId))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export async function saveChangeRecord(record: ChangeRecord): Promise<void> {
  await (await getDatabase()).put('changeRecords', record);
}

export async function listChangeRecords(projectId: string): Promise<ChangeRecord[]> {
  return (await (await getDatabase()).getAllFromIndex('changeRecords', 'by-project', projectId))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export async function saveLogSummary(summary: ServerLogSummary): Promise<void> {
  await (await getDatabase()).put('logSummaries', summary);
}

export async function latestLogSummary(projectId: string): Promise<ServerLogSummary | undefined> {
  const summaries = await (await getDatabase()).getAllFromIndex('logSummaries', 'by-project', projectId);
  return summaries.sort((left, right) => Date.parse(right.importedAt) - Date.parse(left.importedAt))[0];
}

export async function latestSemReport(projectId: string): Promise<SemDiagnosticReport | undefined> {
  const reports = await (await getDatabase()).getAllFromIndex('semReports', 'by-project', projectId);
  return reports.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
}

export async function saveTrackingRun(run: TrackingTestRun): Promise<void> {
  const database = await getDatabase();
  await database.put('trackingRuns', { ...run, observations: run.observations.slice(-200) });
  const runs = await database.getAllFromIndex('trackingRuns', 'by-project', run.projectId);
  for (const stale of runs.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt)).slice(20)) {
    await database.delete('trackingRuns', stale.id);
  }
}

export async function listTrackingRuns(projectId: string): Promise<TrackingTestRun[]> {
  return (await (await getDatabase()).getAllFromIndex('trackingRuns', 'by-project', projectId))
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}

export async function listRunningTrackingRunsForTab(tabId: number): Promise<TrackingTestRun[]> {
  return (await (await getDatabase()).getAll('trackingRuns'))
    .filter((run) => run.status === 'running' && run.tabId === tabId)
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}

export async function getTrackingRun(runId: string): Promise<TrackingTestRun | undefined> {
  return (await getDatabase()).get('trackingRuns', runId);
}

export async function deleteTrackingRun(runId: string): Promise<void> {
  await (await getDatabase()).delete('trackingRuns', runId);
}

export async function clearOverseasProjectData(projectId: string): Promise<void> {
  const database = await getDatabase();
  const analyticsDatasets = (await database.getAllFromIndex('datasets', 'by-project', projectId))
    .filter((dataset) => dataset.kind === 'analytics_performance');
  for (const dataset of analyticsDatasets) await deleteDataset(dataset);
  const transaction = database.transaction(['trackingRuns', 'overseasReports'], 'readwrite');
  for (const storeName of ['trackingRuns', 'overseasReports'] as const) {
    const keys = await transaction.objectStore(storeName).index('by-project').getAllKeys(projectId);
    for (const key of keys) await transaction.objectStore(storeName).delete(key);
  }
  await transaction.done;
}

export async function saveOverseasReport(report: TrackingReconciliationReport): Promise<void> {
  await (await getDatabase()).put('overseasReports', report);
}

export async function latestOverseasReport(projectId: string): Promise<TrackingReconciliationReport | undefined> {
  const reports = await (await getDatabase()).getAllFromIndex('overseasReports', 'by-project', projectId);
  return reports.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
}

export async function deleteProject(projectId: string): Promise<void> {
  const database = await getDatabase();
  const datasets = await database.getAllFromIndex('datasets', 'by-project', projectId);
  for (const dataset of datasets) await deleteDataset(dataset);
  const transaction = database.transaction(['projects', 'siteRuns', 'sitePages', 'semReports', 'remediationTasks', 'auditBaselines', 'changeRecords', 'logSummaries', 'trackingRuns', 'overseasReports'], 'readwrite');
  for (const storeName of ['siteRuns', 'sitePages', 'semReports', 'remediationTasks', 'auditBaselines', 'changeRecords', 'logSummaries', 'trackingRuns', 'overseasReports'] as const) {
    const keys = await transaction.objectStore(storeName).index('by-project').getAllKeys(projectId);
    for (const key of keys) await transaction.objectStore(storeName).delete(key);
  }
  await transaction.objectStore('projects').delete(projectId);
  await transaction.done;
}

export async function clearAllProjectData(): Promise<void> {
  const database = await getDatabase();
  const stores = ['projects', 'datasets', 'seoRows', 'semRows', 'creativeRows', 'businessRows', 'analyticsRows', 'siteRuns', 'sitePages', 'semReports', 'remediationTasks', 'auditBaselines', 'changeRecords', 'logSummaries', 'trackingRuns', 'overseasReports'] as const;
  const transaction = database.transaction(stores, 'readwrite');
  for (const store of stores) await transaction.objectStore(store).clear();
  await transaction.done;
}
