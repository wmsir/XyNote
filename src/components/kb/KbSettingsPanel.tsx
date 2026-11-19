import React, { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Database,
  FolderOpen,
  Network,
  Power,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  kbGetStatus,
  kbPurgeIndex,
  kbRebuildIndex,
  kbSetConfig,
  kbSetEnabled,
} from "../../api/kb";
import type { KbStatus } from "../../types/notion";

export interface KbSettingsPanelProps {
  status: KbStatus | null;
  onStatusChange: (next: KbStatus) => void;
  onNotify: (msg: string) => void;
  onOpenIndexFolder?: (dbPath: string) => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "尚未同步";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

export const KbSettingsPanel: React.FC<KbSettingsPanelProps> = ({
  status,
  onStatusChange,
  onNotify,
  onOpenIndexFolder,
}) => {
  const [localStatus, setLocalStatus] = useState<KbStatus | null>(status);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [banner, setBanner] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    setLocalStatus(status);
  }, [status]);

  useEffect(() => {
    let alive = true;
    kbGetStatus()
      .then((st) => {
        if (alive) {
          setLocalStatus(st);
          onStatusChange(st);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [onStatusChange]);

  const applyStatus = useCallback(
    (next: KbStatus, successText?: string) => {
      setLocalStatus(next);
      onStatusChange(next);
      if (successText) {
        setBanner({ kind: "success", text: successText });
        onNotify(successText);
      }
    },
    [onNotify, onStatusChange]
  );

  const handleEnable = async () => {
    setBusyAction("enable");
    setBanner(null);
    try {
      const next = await kbSetEnabled(true, false);
      applyStatus(
        next,
        `已开启本地知识库（已收录 ${next.sourceCount} 篇笔记、${next.eventCount} 个内容片段）`
      );
    } catch (err) {
      setBanner({
        kind: "error",
        text: `开启知识库失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleDisableKeep = async () => {
    setBusyAction("disable");
    setBanner(null);
    try {
      const next = await kbSetEnabled(false, false);
      applyStatus(
        next,
        "已切换回简洁写作模式（索引数据已保留，下次开启无需重新扫描）"
      );
    } catch (err) {
      setBanner({
        kind: "error",
        text: `关闭知识库失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handlePurge = async () => {
    setBusyAction("purge");
    setBanner(null);
    try {
      const next = await kbPurgeIndex();
      applyStatus(
        next,
        "已关闭并清除知识库引擎（原有笔记不受任何影响）"
      );
    } catch (err) {
      setBanner({
        kind: "error",
        text: `清除知识库索引失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggleFolders = async () => {
    if (!localStatus) return;
    setBusyAction("toggle-folders");
    setBanner(null);
    try {
      const nextVal = !localStatus.includeFolders;
      const next = await kbSetConfig({ includeFolders: nextVal });
      applyStatus(
        next,
        nextVal ? "已开启本地文件夹协同检索" : "已暂停本地文件夹检索，仅检索工作区笔记"
      );
    } catch (err) {
      setBanner({
        kind: "error",
        text: `更新目录索引配置失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggleRelatedPanel = async () => {
    if (!localStatus) return;
    setBusyAction("toggle-panel");
    setBanner(null);
    try {
      const nextVal = !localStatus.showRelatedPanel;
      const next = await kbSetConfig({ showRelatedPanel: nextVal });
      applyStatus(
        next,
        nextVal ? "已在编辑器右侧开启「关联知识」面板" : "已隐藏编辑器右侧「关联知识」面板"
      );
    } catch (err) {
      setBanner({
        kind: "error",
        text: `切换关联面板设置失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleRebuild = async (forceFull: boolean) => {
    setBusyAction(forceFull ? "full-rebuild" : "inc-rebuild");
    setBanner(null);
    try {
      const next = await kbRebuildIndex(forceFull);
      applyStatus(
        next,
        forceFull
          ? `已完成索引重建（${next.sourceCount} 篇笔记 · ${next.eventCount} 个片段 · ${next.entityCount} 个主题）`
          : `已完成索引更新（${next.sourceCount} 篇笔记 · ${next.eventCount} 个片段）`
      );
    } catch (err) {
      setBanner({
        kind: "error",
        text: `重建知识库索引失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const isEnabled = Boolean(localStatus?.enabled);

  return (
    <div className="nb-settings-section-stack">
      <div>
        <h3 className="nb-settings-heading">本地知识库引擎（可选开启）</h3>
        <p className="nb-settings-desc">
          默认关闭。开启后会在本地独立建立知识索引，绝不改动原有笔记；支持跨文档智能关联搜索与右侧相关笔记推荐，完全离线运行。
        </p>
      </div>

      {banner && (
        <div
          className={`nb-settings-banner ${
            banner.kind === "error" ? "is-error" : "is-success"
          }`}
        >
          <CheckCircle2 size={15} style={{ flexShrink: 0 }} />
          <span>{banner.text}</span>
        </div>
      )}

      {/* 状态与热插拔主开关横幅 */}
      <div className="nb-storage-portable-banner">
        <div className="nb-storage-portable-top">
          <span className="nb-storage-badge">
            {isEnabled
              ? "个人知识库模式（已开启）"
              : "简洁写作模式（已关闭）"}
          </span>
          <span
            className="nb-storage-meta"
            style={isEnabled ? undefined : { color: "var(--text-secondary)" }}
          >
            {isEnabled
              ? "✓ 独立索引 · 自动更新"
              : "零额外占用 · 不改动原笔记"}
          </span>
        </div>

        <div className="nb-storage-portable-line">
          {isEnabled
            ? "可在 Ctrl+K 搜索中发现跨文档关联内容，并在编辑器右侧自动推荐相关笔记与主题线索。"
            : "当前为纯粹的离线写作模式，不会建立知识库索引，也不占用后台资源。"}
        </div>

        <div className="nb-settings-actions-bar" style={{ marginTop: "6px" }}>
          {!isEnabled ? (
            <button
              type="button"
              className="nb-btn-primary"
              disabled={busyAction !== null}
              onClick={handleEnable}
            >
              <Network size={14} />
              {busyAction === "enable" ? "正在建立索引..." : "一键开启本地知识库"}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="nb-btn-secondary"
                disabled={busyAction !== null}
                onClick={handleDisableKeep}
              >
                <Power size={14} />
                {busyAction === "disable" ? "正在关闭..." : "关闭（保留索引）"}
              </button>
              <button
                type="button"
                className="nb-btn-danger"
                disabled={busyAction !== null}
                onClick={handlePurge}
              >
                <Trash2 size={14} />
                {busyAction === "purge" ? "正在清除..." : "关闭并清除引擎"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* 独立索引状态信息 */}
      {localStatus && (isEnabled || localStatus.dbExists) && (
        <div className="nb-settings-card-box">
          <div className="nb-settings-row-head">
            <div>
              <div className="nb-settings-label">
                知识库索引状态（与原笔记完全隔离）
              </div>
              <div className="nb-settings-sub">
                索引数据单独保存，清除后不会影响任何笔记，随时可重新生成。
              </div>
            </div>
            {onOpenIndexFolder && localStatus.dbExists && (
              <button
                type="button"
                className="nb-btn-secondary"
                onClick={() => onOpenIndexFolder(localStatus.dbPath)}
              >
                <FolderOpen size={14} /> 打开所在目录
              </button>
            )}
          </div>

          <div className="nb-storage-kv-grid">
            <div className="nb-storage-kv-item">
              <span className="nb-storage-kv-key">索引占用空间</span>
              <span className="nb-storage-kv-val">
                {localStatus.dbExists ? formatBytes(localStatus.dbSizeBytes) : "尚未创建"}
              </span>
            </div>
            {isEnabled && (
              <>
                <div className="nb-storage-kv-item">
                  <span className="nb-storage-kv-key">已收录内容</span>
                  <span className="nb-storage-kv-val">
                    {`${localStatus.sourceCount} 篇 · ${localStatus.eventCount} 个片段 · ${localStatus.entityCount} 个主题`}
                  </span>
                </div>
                <div className="nb-storage-kv-item">
                  <span className="nb-storage-kv-key">最近更新时间</span>
                  <span className="nb-storage-kv-val">
                    {formatDateTime(localStatus.lastIndexedAt)}
                  </span>
                </div>
              </>
            )}
          </div>

          {!isEnabled && localStatus.dbExists && (
            <div className="nb-settings-actions-bar">
              <button
                type="button"
                className="nb-btn-danger"
                disabled={busyAction !== null}
                onClick={handlePurge}
              >
                <Trash2 size={14} /> 清除残留索引
              </button>
            </div>
          )}
        </div>
      )}

      {/* 运行期子开关与索引控制 */}
      {isEnabled && localStatus && (
        <div className="nb-settings-card-box">
          <div className="nb-settings-toggle-row">
            <div>
              <div className="nb-settings-label">同时检索侧栏打开的本地文件夹</div>
              <div className="nb-settings-sub">
                自动将侧栏文件夹中的 Markdown 和文本纳入搜索与关联推荐（只读取，不修改原文件）
              </div>
            </div>
            <button
              type="button"
              className={`nb-toggle-switch${localStatus.includeFolders ? " is-on" : ""}`}
              disabled={busyAction !== null}
              onClick={handleToggleFolders}
              aria-label="同时检索侧栏打开的本地文件夹"
            />
          </div>

          <div className="nb-menu-divider" />

          <div className="nb-settings-toggle-row">
            <div>
              <div className="nb-settings-label">编辑器右侧显示「关联知识」面板</div>
              <div className="nb-settings-sub">
                写作时自动在右侧推荐与当前内容相关的历史笔记与本地文件，点击即可跳转
              </div>
            </div>
            <button
              type="button"
              className={`nb-toggle-switch${localStatus.showRelatedPanel ? " is-on" : ""}`}
              disabled={busyAction !== null}
              onClick={handleToggleRelatedPanel}
              aria-label="编辑器右侧显示「关联知识」面板"
            />
          </div>

          <div className="nb-menu-divider" />

          <div className="nb-settings-actions-bar">
            <button
              type="button"
              className="nb-btn-secondary"
              disabled={busyAction !== null}
              onClick={() => handleRebuild(false)}
            >
              <RefreshCw size={14} />
              {busyAction === "inc-rebuild" ? "更新中..." : "更新索引"}
            </button>
            <button
              type="button"
              className="nb-btn-secondary"
              disabled={busyAction !== null}
              onClick={() => handleRebuild(true)}
            >
              <Database size={14} />
              {busyAction === "full-rebuild" ? "重建中..." : "重建索引"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
