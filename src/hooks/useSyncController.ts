import { useCallback, useEffect, useRef, useState } from "react";
import { isTauriRuntime } from "../api/client";
import { getSyncConfig, runSync, syncErrorText, type SyncConfig, type SyncReport } from "../api/sync";

const EDIT_DEBOUNCE_MS = 30_000;

interface Options {
  /** 应用已加载完工作区（避免启动时与初始化抢数据库） */
  ready: boolean;
  /** 本地正在写盘；从 true 变回 false 视为一次编辑 */
  isSaving: boolean;
  /** 同步前先把编辑器里未保存的内容写入数据库 */
  flushPendingSaves: () => Promise<void>;
  /** 同步带来了远端变更（下载、删除或冲突副本） */
  onRemoteChanges: (report: SyncReport) => Promise<void> | void;
  showToast: (msg: string) => void;
}

/**
 * 同步调度：启动时、编辑停止约半分钟后、以及按设置的间隔自动同步。
 * 纯本地模式下什么也不做。
 */
export function useSyncController({ ready, isSaving, flushPendingSaves, onRemoteChanges, showToast }: Options) {
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const editTimer = useRef<number | null>(null);
  const wasSaving = useRef(false);
  const lastErrorShown = useRef<string | null>(null);

  const cbRef = useRef({ flushPendingSaves, onRemoteChanges, showToast });
  cbRef.current = { flushPendingSaves, onRemoteChanges, showToast };

  const enabled = !!config && config.mode !== "local";
  const auto = enabled && config!.autoSync;

  useEffect(() => {
    if (!isTauriRuntime()) return;
    getSyncConfig().then(setConfig).catch(() => {});
  }, []);

  const syncNow = useCallback(async (manual: boolean) => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      await cbRef.current.flushPendingSaves();
      const report = await runSync();
      lastErrorShown.current = null;
      if (report) {
        if (report.downloaded + report.deletedLocal + report.conflicts > 0) {
          await cbRef.current.onRemoteChanges(report);
        }
        if (report.conflicts > 0) {
          cbRef.current.showToast(`同步发现 ${report.conflicts} 处冲突，另一份已保存为「冲突副本」`);
        } else if (manual) {
          cbRef.current.showToast(
            report.uploaded + report.downloaded + report.deletedLocal + report.deletedRemote === 0
              ? "已是最新"
              : `同步完成：上传 ${report.uploaded}，下载 ${report.downloaded}`
          );
        }
      }
    } catch (e) {
      const msg = syncErrorText(e);
      // 自动同步失败只提示一次，避免断网时反复弹出
      if (manual || lastErrorShown.current !== msg) {
        cbRef.current.showToast(`同步失败：${msg}`);
        lastErrorShown.current = msg;
      }
      if (manual) throw e;
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      getSyncConfig().then(setConfig).catch(() => {});
    }
  }, []);

  // 启动后同步一次
  const startedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !auto) return;
    const sig = config!.mode;
    if (startedFor.current === sig) return;
    startedFor.current = sig;
    syncNow(false).catch(() => {});
  }, [ready, auto, config, syncNow]);

  // 定时同步
  const intervalMinutes = config?.intervalMinutes ?? 5;
  useEffect(() => {
    if (!ready || !auto) return;
    const id = window.setInterval(() => syncNow(false).catch(() => {}), Math.max(1, intervalMinutes) * 60_000);
    return () => window.clearInterval(id);
  }, [ready, auto, intervalMinutes, syncNow]);

  // 编辑后防抖同步
  useEffect(() => {
    if (wasSaving.current && !isSaving && auto && !syncingRef.current) {
      if (editTimer.current) window.clearTimeout(editTimer.current);
      editTimer.current = window.setTimeout(() => {
        editTimer.current = null;
        syncNow(false).catch(() => {});
      }, EDIT_DEBOUNCE_MS);
    }
    wasSaving.current = isSaving;
  }, [isSaving, auto, syncNow]);

  useEffect(
    () => () => {
      if (editTimer.current) window.clearTimeout(editTimer.current);
    },
    []
  );

  return {
    syncConfig: config,
    setSyncConfig: setConfig,
    syncing,
    syncNow: useCallback(() => syncNow(true), [syncNow]),
  };
}
