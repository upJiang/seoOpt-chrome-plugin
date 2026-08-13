import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAuditReport } from '../src/lib/audit/rules';
import type { AiChatEntry, AiConversation } from '../src/lib/audit/types';
import {
  aiConversationKey,
  clearAiKey,
  clearAllAiConversations,
  ensureAiConversation,
  getAiKey,
  getAiConversation,
  getPreferences,
  hasAiKey,
  setAiKey,
  setAiConversation,
} from '../src/lib/storage';
import { healthySnapshot } from './fixtures/snapshots';

function createStorageArea(store: Record<string, unknown>): chrome.storage.StorageArea {
  return {
    get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
      if (keys === null || keys === undefined) return { ...store };
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, store[key]]));
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, store[key] ?? fallback]));
    }),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(store, items); }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    }),
    clear: vi.fn(async () => {
      for (const key of Object.keys(store)) delete store[key];
    }),
    getBytesInUse: vi.fn(async () => 0),
    onChanged: {} as chrome.storage.StorageArea['onChanged'],
    setAccessLevel: vi.fn(async () => undefined),
  } as unknown as chrome.storage.StorageArea;
}

describe('website AI conversation storage', () => {
  let localStore: Record<string, unknown>;
  let sessionStore: Record<string, unknown>;

  beforeEach(() => {
    localStore = {};
    sessionStore = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: createStorageArea(localStore),
        session: createStorageArea(sessionStore),
      },
    });
  });

  it('shares one conversation across pages on the same origin and records refreshed evidence', async () => {
    const firstReport = buildAuditReport(healthySnapshot(), 3);
    const first = await ensureAiConversation(firstReport, '第一次页面证据');
    await setAiConversation({
      ...first,
      entries: [{
        id: 'message-1',
        role: 'user',
        content: '先修什么？',
        createdAt: first.createdAt,
        reportId: firstReport.id,
      }],
    });

    const secondReport = buildAuditReport(healthySnapshot({
      id: 'snapshot-2',
      url: 'https://example.com/products/new',
      titleTags: ['新页面标题'],
    }), 4);
    const refreshed = await ensureAiConversation(secondReport, '第二次页面证据');

    expect(refreshed.origin).toBe('https://example.com');
    expect(refreshed.context.reportId).toBe(secondReport.id);
    expect(refreshed.context.page.url).toContain('/products/new');
    expect(refreshed.entries[0]).toMatchObject({ id: 'message-1', role: 'user' });
    expect(refreshed.entries.at(-1)).toMatchObject({ type: 'context_update', reportId: secondReport.id });
  });

  it('persists the API Key locally across browser sessions and clears it only on request', async () => {
    await setAiKey('persistent-test-key');

    expect(localStore['seo-opt:ai-key']).toBe('persistent-test-key');
    expect(sessionStore['seo-opt:ai-key']).toBeUndefined();
    expect(await hasAiKey()).toBe(true);
    expect(await getAiKey()).toBe('persistent-test-key');

    await clearAiKey();
    expect(await hasAiKey()).toBe(false);
    expect(localStore['seo-opt:ai-key']).toBeUndefined();
  });

  it('migrates a legacy session API Key into local storage', async () => {
    sessionStore['seo-opt:ai-key'] = 'legacy-session-key';

    expect(await getAiKey()).toBe('legacy-session-key');
    expect(localStore['seo-opt:ai-key']).toBe('legacy-session-key');
    expect(sessionStore['seo-opt:ai-key']).toBeUndefined();
  });

  it('reads legacy settings while discarding removed theme and AI switch fields', async () => {
    localStore['seo-opt:preferences'] = {
      theme: 'dark',
      ai: { enabled: false, endpoint: 'https://codecc.cc/v1', model: 'test-model' },
    };

    expect(await getPreferences()).toEqual({
      ai: { endpoint: 'https://codecc.cc/v1', model: 'test-model' },
    });
  });

  it('keeps only the latest 20 chat messages while retaining recent context dividers', async () => {
    const report = buildAuditReport(healthySnapshot(), 3);
    const conversation = await ensureAiConversation(report);
    const entries: AiChatEntry[] = Array.from({ length: 30 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `消息 ${index}`,
      createdAt: new Date(Date.parse(conversation.createdAt) + index * 1_000).toISOString(),
      reportId: report.id,
    }));
    entries.splice(2, 0, {
      id: 'context-event',
      type: 'context_update',
      reportId: report.id,
      url: report.url,
      createdAt: report.createdAt,
    });

    await setAiConversation({ ...conversation, entries });
    const saved = await getAiConversation(conversation.origin);
    const messages = saved?.entries.filter((entry) => 'role' in entry) ?? [];

    expect(messages).toHaveLength(20);
    expect(messages[0]?.id).toBe('message-10');
    expect(saved?.entries.some((entry) => 'type' in entry && entry.id === 'context-event')).toBe(true);
  });

  it('removes least-recently-used sites after the twentieth conversation', async () => {
    for (let index = 0; index < 21; index += 1) {
      const report = buildAuditReport(healthySnapshot({
        url: `https://site-${index}.example/page`,
        origin: `https://site-${index}.example`,
      }), index + 1);
      const conversation = await ensureAiConversation(report);
      await setAiConversation({
        ...conversation,
        updatedAt: new Date(Date.parse('2026-08-03T08:00:00.000Z') + index * 1_000).toISOString(),
      });
    }

    const keys = Object.keys(localStore).filter((key) => key.startsWith('seo-opt:ai-conversation:'));
    expect(keys).toHaveLength(20);
    expect(localStore[aiConversationKey('https://site-0.example')]).toBeUndefined();
    expect(localStore[aiConversationKey('https://site-20.example')]).toBeDefined();
  });

  it('clears every saved website conversation without deleting unrelated preferences', async () => {
    localStore['seo-opt:preferences'] = { theme: 'light' };
    localStore[aiConversationKey('https://one.example')] = { version: 1 } as AiConversation;
    localStore[aiConversationKey('https://two.example')] = { version: 1 } as AiConversation;

    await clearAllAiConversations();

    expect(Object.keys(localStore)).toEqual(['seo-opt:preferences']);
  });
});
