// @vitest-environment node
import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';
import { openDB } from 'idb';

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

describe('IndexedDB v1 to v3 migration', () => {
  afterEach(async () => {
    const database = await (await import('../src/lib/projects/db')).getDatabase();
    database.close();
    await deleteDatabase('seo-opt-workbench');
  });

  it('preserves existing projects and adds remediation stores', async () => {
    const legacy = await openDB('seo-opt-workbench', 1, {
      upgrade(database) {
        const projects = database.createObjectStore('projects', { keyPath: 'id' });
        projects.createIndex('by-origin', 'origin');
        projects.createIndex('by-updated', 'updatedAt');
        const datasets = database.createObjectStore('datasets', { keyPath: 'id' });
        datasets.createIndex('by-project', 'projectId');
        datasets.createIndex('by-fingerprint', 'fingerprint');
        for (const name of ['seoRows', 'semRows', 'creativeRows', 'businessRows']) {
          const store = database.createObjectStore(name, { keyPath: 'id' });
          store.createIndex('by-project', 'projectId');
          store.createIndex('by-dataset', 'datasetId');
        }
        const runs = database.createObjectStore('siteRuns', { keyPath: 'id' });
        runs.createIndex('by-project', 'projectId');
        runs.createIndex('by-updated', 'updatedAt');
        const pages = database.createObjectStore('sitePages', { keyPath: 'id' });
        pages.createIndex('by-project', 'projectId');
        pages.createIndex('by-run', 'runId');
        const reports = database.createObjectStore('semReports', { keyPath: 'id' });
        reports.createIndex('by-project', 'projectId');
        reports.createIndex('by-created', 'createdAt');
      },
    });
    await legacy.put('projects', { id: 'legacy', name: 'Legacy', origin: 'https://example.com', market: '中国', timezone: 'Asia/Shanghai', currency: 'CNY', brandTerms: [], primaryConversion: '', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', sem: { businessType: 'lead_generation', negativeTerms: [], targetCpa: null, targetRoas: null, grossProfitPerConversion: null } });
    legacy.close();

    const { getDatabase, getProject } = await import('../src/lib/projects/db');
    const database = await getDatabase();
    expect(database.version).toBe(3);
    expect(await getProject('legacy')).toMatchObject({ id: 'legacy', sem: { landingTargetQuery: '', adPromise: '' }, international: { searchEngine: 'both', conversionDomains: [] } });
    expect([...database.objectStoreNames]).toEqual(expect.arrayContaining(['remediationTasks', 'auditBaselines', 'changeRecords', 'logSummaries', 'analyticsRows', 'trackingRuns', 'overseasReports']));
  });
});
