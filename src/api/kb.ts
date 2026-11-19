/**
 * 可插拔 SAG2 本地知识库引擎 API（独立 kb_index.db，默认关闭）。
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  KbRelatedResponse,
  KbSearchHit,
  KbSearchResponse,
  KbStatus,
} from "../types/notion";
import { isTauriRuntime } from "./client";

const BROWSER_KB_PREFS_KEY = "xynote_kb_browser_v1";

interface BrowserKbPrefs {
  enabled: boolean;
  includeFolders: boolean;
  showRelatedPanel: boolean;
  lastIndexedAt: string | null;
}

function readBrowserPrefs(): BrowserKbPrefs {
  try {
    const raw = localStorage.getItem(BROWSER_KB_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<BrowserKbPrefs>;
      return {
        enabled: parsed.enabled === true,
        includeFolders: parsed.includeFolders !== false,
        showRelatedPanel: parsed.showRelatedPanel !== false,
        lastIndexedAt: parsed.lastIndexedAt ?? null,
      };
    }
  } catch {
    // ignore storage errors
  }
  return {
    enabled: false,
    includeFolders: true,
    showRelatedPanel: true,
    lastIndexedAt: null,
  };
}

function writeBrowserPrefs(prefs: BrowserKbPrefs): KbStatus {
  try {
    localStorage.setItem(BROWSER_KB_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore storage errors
  }
  return {
    enabled: prefs.enabled,
    includeFolders: prefs.includeFolders,
    showRelatedPanel: prefs.showRelatedPanel,
    dbPath: "浏览器预览模式（本地知识库仅在桌面版可用）",
    dbExists: false,
    dbSizeBytes: 0,
    sourceCount: 0,
    eventCount: 0,
    entityCount: 0,
    indexing: false,
    lastIndexedAt: prefs.lastIndexedAt,
    lastError: null,
  };
}

export async function kbGetStatus(): Promise<KbStatus> {
  if (isTauriRuntime()) {
    return invoke<KbStatus>("kb_get_status");
  }
  return writeBrowserPrefs(readBrowserPrefs());
}

export async function kbSetEnabled(
  enabled: boolean,
  purgeIndex = false
): Promise<KbStatus> {
  if (isTauriRuntime()) {
    return invoke<KbStatus>("kb_set_enabled", { enabled, purgeIndex });
  }
  const cur = readBrowserPrefs();
  return writeBrowserPrefs({
    ...cur,
    enabled,
    lastIndexedAt: enabled ? new Date().toISOString() : purgeIndex ? null : cur.lastIndexedAt,
  });
}

export async function kbSetConfig(patch: {
  includeFolders?: boolean;
  showRelatedPanel?: boolean;
}): Promise<KbStatus> {
  if (isTauriRuntime()) {
    return invoke<KbStatus>("kb_set_config", {
      includeFolders: patch.includeFolders ?? null,
      showRelatedPanel: patch.showRelatedPanel ?? null,
    });
  }
  const cur = readBrowserPrefs();
  return writeBrowserPrefs({
    ...cur,
    includeFolders: patch.includeFolders ?? cur.includeFolders,
    showRelatedPanel: patch.showRelatedPanel ?? cur.showRelatedPanel,
  });
}

export async function kbRebuildIndex(forceFull = false): Promise<KbStatus> {
  if (isTauriRuntime()) {
    return invoke<KbStatus>("kb_rebuild_index", { forceFull });
  }
  const cur = readBrowserPrefs();
  return writeBrowserPrefs({
    ...cur,
    lastIndexedAt: cur.enabled ? new Date().toISOString() : cur.lastIndexedAt,
  });
}

export async function kbPurgeIndex(): Promise<KbStatus> {
  if (isTauriRuntime()) {
    return invoke<KbStatus>("kb_purge_index");
  }
  const cur = readBrowserPrefs();
  return writeBrowserPrefs({
    ...cur,
    enabled: false,
    lastIndexedAt: null,
  });
}

export async function kbSearch(
  query: string,
  limit = 24,
  hops = 1
): Promise<KbSearchResponse> {
  if (isTauriRuntime()) {
    return invoke<KbSearchResponse>("kb_search", { query, limit, hops });
  }
  return {
    query,
    totalSources: 0,
    totalEvents: 0,
    elapsedMs: 0,
    hits: [],
    topEntities: [],
  };
}

export async function kbRelatedForContext(
  sourceKind: string,
  refId: string,
  title: string,
  contentText: string,
  limit = 8
): Promise<KbRelatedResponse> {
  if (isTauriRuntime()) {
    return invoke<KbRelatedResponse>("kb_related_for_context", {
      sourceKind,
      refId,
      title,
      contentText,
      limit,
    });
  }
  return {
    contextEntities: [],
    hits: [],
    elapsedMs: 0,
  };
}

export async function kbEntityEvents(
  entityName: string,
  limit = 30
): Promise<KbSearchHit[]> {
  if (isTauriRuntime()) {
    return invoke<KbSearchHit[]>("kb_entity_events", { entityName, limit });
  }
  return [];
}
