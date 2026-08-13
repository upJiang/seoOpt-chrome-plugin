import { buildAiContextBundle, buildJointAiContextBundle, originForReport } from './ai';
import {
  DEFAULT_PREFERENCES,
  type AiChatContextEvent,
  type AiChatEntry,
  type AiChatMessage,
  type AiConversation,
  type AuditReport,
  type ScanState,
  type UserPreferences,
} from './audit/types';
import type { SearchProject } from './projects/types';

const PREFERENCES_KEY = 'seo-opt:preferences';
const AI_KEY = 'seo-opt:ai-key';
const AI_CONVERSATION_PREFIX = 'seo-opt:ai-conversation:';
const MAX_AI_SITES = 20;
const MAX_AI_MESSAGES_PER_SITE = 20;
const MAX_CONTEXT_EVENTS_PER_SITE = 6;

export function scanStateKey(tabId: number): string {
  return `seo-opt:scan:${tabId}`;
}

export function aiConversationKey(origin: string): string {
  return `${AI_CONVERSATION_PREFIX}${encodeURIComponent(new URL(origin).origin)}`;
}

export function projectAiConversationKey(projectId: string): string {
  return `${AI_CONVERSATION_PREFIX}project:${encodeURIComponent(projectId)}`;
}

export async function getScanState(tabId: number): Promise<ScanState> {
  const key = scanStateKey(tabId);
  const result = await chrome.storage.session.get(key);
  return (result[key] as ScanState | undefined) ?? { status: 'idle', tabId };
}

export async function setScanState(tabId: number, state: ScanState): Promise<void> {
  await chrome.storage.session.set({ [scanStateKey(tabId)]: state });
}

export async function getPreferences(): Promise<UserPreferences> {
  const result = await chrome.storage.local.get(PREFERENCES_KEY);
  const stored = result[PREFERENCES_KEY] as {
    ai?: { endpoint?: unknown; model?: unknown };
  } | undefined;
  return {
    ai: {
      endpoint: typeof stored?.ai?.endpoint === 'string' ? stored.ai.endpoint : DEFAULT_PREFERENCES.ai.endpoint,
      model: typeof stored?.ai?.model === 'string' ? stored.ai.model : DEFAULT_PREFERENCES.ai.model,
    },
  };
}

export async function setPreferences(preferences: UserPreferences): Promise<void> {
  await chrome.storage.local.set({ [PREFERENCES_KEY]: preferences });
}

export async function getAiKey(): Promise<string> {
  const local = await chrome.storage.local.get(AI_KEY);
  if (typeof local[AI_KEY] === 'string' && local[AI_KEY]) return local[AI_KEY];

  // Migrate keys saved by versions before 0.3 without asking the user to enter them again.
  const legacy = await chrome.storage.session.get(AI_KEY);
  const legacyKey = typeof legacy[AI_KEY] === 'string' ? legacy[AI_KEY] : '';
  if (legacyKey) {
    await chrome.storage.local.set({ [AI_KEY]: legacyKey });
    await chrome.storage.session.remove(AI_KEY);
  }
  return legacyKey;
}

export async function setAiKey(apiKey: string): Promise<void> {
  const normalized = apiKey.trim();
  if (normalized) await chrome.storage.local.set({ [AI_KEY]: normalized });
  else await chrome.storage.local.remove(AI_KEY);
  await chrome.storage.session.remove(AI_KEY);
}

export async function hasAiKey(): Promise<boolean> {
  return Boolean(await getAiKey());
}

export async function clearAiKey(): Promise<void> {
  await Promise.all([
    chrome.storage.local.remove(AI_KEY),
    chrome.storage.session.remove(AI_KEY),
  ]);
}

function validConversation(value: unknown): value is AiConversation {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AiConversation>;
  return candidate.version === 1
    && typeof candidate.origin === 'string'
    && Boolean(candidate.context)
    && Array.isArray(candidate.entries)
    && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string';
}

function trimConversationEntries(entries: AiChatEntry[]): AiChatEntry[] {
  const messages = entries.filter((entry): entry is AiChatMessage => 'role' in entry).slice(-MAX_AI_MESSAGES_PER_SITE);
  const messageIds = new Set(messages.map((message) => message.id));
  const events = entries
    .filter((entry): entry is AiChatContextEvent => 'type' in entry && entry.type === 'context_update')
    .slice(-MAX_CONTEXT_EVENTS_PER_SITE);
  const eventIds = new Set(events.map((event) => event.id));
  return entries.filter((entry) => ('role' in entry ? messageIds.has(entry.id) : eventIds.has(entry.id)));
}

async function enforceConversationLimit(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const conversations = Object.entries(all)
    .filter(([key, value]) => key.startsWith(AI_CONVERSATION_PREFIX) && validConversation(value))
    .sort(([, left], [, right]) => Date.parse((right as AiConversation).updatedAt) - Date.parse((left as AiConversation).updatedAt));
  const staleKeys = conversations.slice(MAX_AI_SITES).map(([key]) => key);
  if (staleKeys.length > 0) await chrome.storage.local.remove(staleKeys);
}

export async function getAiConversation(origin: string, projectId?: string): Promise<AiConversation | null> {
  const legacyKey = aiConversationKey(origin);
  const projectKey = projectId ? projectAiConversationKey(projectId) : '';
  const result = await chrome.storage.local.get(projectKey ? [projectKey, legacyKey] : legacyKey);
  if (projectKey && validConversation(result[projectKey])) return result[projectKey];
  if (!validConversation(result[legacyKey])) return null;
  const legacy = result[legacyKey];
  if (!projectId) return legacy;
  const migrated = { ...legacy, projectId };
  await chrome.storage.local.set({ [projectKey]: migrated });
  await chrome.storage.local.remove(legacyKey);
  return migrated;
}

export async function setAiConversation(conversation: AiConversation): Promise<AiConversation> {
  const trimmed = { ...conversation, entries: trimConversationEntries(conversation.entries) };
  const key = trimmed.projectId ? projectAiConversationKey(trimmed.projectId) : aiConversationKey(trimmed.origin);
  await chrome.storage.local.set({ [key]: trimmed });
  await enforceConversationLimit();
  return trimmed;
}

export async function ensureAiConversation(
  report: AuditReport,
  visibleTextExcerpt = '',
  project?: SearchProject,
): Promise<AiConversation> {
  const origin = originForReport(report);
  const existing = await getAiConversation(origin, project?.id);
  const now = new Date().toISOString();
  const context = project
    ? await buildJointAiContextBundle(report, project, visibleTextExcerpt)
    : buildAiContextBundle(report, visibleTextExcerpt);
  if (!existing) {
    return {
      version: 1,
      origin,
      ...(project ? { projectId: project.id } : {}),
      context,
      entries: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  const changed = existing.context.reportId !== report.id;
  const contextEvent: AiChatContextEvent | null = changed ? {
    id: crypto.randomUUID(),
    type: 'context_update',
    reportId: report.id,
    url: report.url,
    createdAt: report.createdAt,
  } : null;
  return {
    ...existing,
    context,
    entries: contextEvent ? [...existing.entries, contextEvent] : existing.entries,
    updatedAt: now,
  };
}

export async function refreshExistingAiConversation(report: AuditReport): Promise<AiConversation | null> {
  const existing = await getAiConversation(originForReport(report));
  if (!existing) return null;
  return setAiConversation(await ensureAiConversation(report));
}

export async function refreshProjectAiConversation(report: AuditReport, project: SearchProject): Promise<AiConversation | null> {
  const existing = await getAiConversation(originForReport(report), project.id);
  if (!existing) return null;
  return setAiConversation(await ensureAiConversation(report, '', project));
}

export async function clearAiConversation(origin: string, projectId?: string): Promise<void> {
  await chrome.storage.local.remove(projectId ? [projectAiConversationKey(projectId), aiConversationKey(origin)] : aiConversationKey(origin));
}

export async function clearAllAiConversations(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(AI_CONVERSATION_PREFIX));
  if (keys.length > 0) await chrome.storage.local.remove(keys);
}
