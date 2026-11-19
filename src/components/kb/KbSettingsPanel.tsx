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
        `已开启 SAG2 本地知识库（已索引 ${next.sourceCount} 篇知识源、${next.eventCount} 个知识块）`
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
        "已切换回传统极简编辑器模式（kb_index.db 索引文件已保留）"
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
        "已关闭知识库并彻底清除独立索引库 kb_index.db（主笔记库零影响）"
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
        nextVal ? "已开启挂载文件夹协同索引" : "已暂停挂载文件夹索引，仅保留工作区笔记"
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
          ? `已完成全量重建（${next.sourceCount} 篇知识源 · ${next.eventCount} 块 · ${next.entityCount} 个概念）`
          : `已完成增量同步（${next.sourceCount} 篇知识源 · ${next.eventCount} 块）`
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
        <h3 className="nb-settings-heading">SAG2 本地知识库引擎（可插拔模块）</h3>
        <p className="nb-settings-desc">
          默认关闭，开启后在同目录独立维护 <code>kb_index.db</code>（绝不修改主笔记库{" "}
          <code>xynote.db</code> 结构）：支持中文语义分词、查询时 SQL 动态超边跨文档多跳检索与实时关联推荐，零向量库与 API 算力开销。
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
              ? "SAG2 个人知识库模式（运行中）"
              : "传统极简编辑器模式（已关闭）"}
          </span>
          <span
            className="nb-storage-meta"
            style={isEnabled ? undefined : { color: "var(--text-secondary)" }}
          >
            {isEnabled
              ? "✓ 独立索引库 · 实时增量同步"
              : "零内存占用 · 主库无入侵"}
          </span>
        </div>

        <div className="nb-storage-portable-line">
          {isEnabled
            ? "可在 Ctrl+K 搜索中发现跨文档动态超边关联，并在编辑器右侧实时查看关联知识卡片与概念追踪。"
            : "当前保持最纯粹的传统离线笔记体验，不创建 kb_index.db，也不启动任何知识库索引线程。"}
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
              {busyAction === "enable" ? "正在建立索引..." : "一键开启 SAG2 本地知识库"}
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
                {busyAction === "purge" ? "正在清理..." : "关闭并清除 kb_index.db"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* 独立索引库状态信息 */}
      {localStatus && (isEnabled || localStatus.dbExists) && (
        <div className="nb-settings-card-box">
          <div className="nb-settings-row-head">
            <div>
              <div className="nb-settings-label">
                独立派生索引文件（与主笔记库物理隔离）
              </div>
              <div className="nb-settings-sub">
                所有索引表与中文 FTS5 全文表均存放在下方独立文件，删除后可随时根据主库重新构建。
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
              <span className="nb-storage-kv-key">索引文件路径</span>
              <code className="nb-storage-kv-val" title={localStatus.dbPath}>
                {localStatus.dbPath}
              </code>
            </div>
            <div className="nb-storage-kv-item">
              <span className="nb-storage-kv-key">索引库体积</span>
              <span className="nb-storage-kv-val">
                {localStatus.dbExists ? formatBytes(localStatus.dbSizeBytes) : "尚未创建"}
              </span>
            </div>
            {isEnabled && (
              <>
                <div className="nb-storage-kv-item">
                  <span className="nb-storage-kv-key">已纳管知识规模</span>
                  <span className="nb-storage-kv-val">
                    {`${localStatus.sourceCount} 篇 · ${localStatus.eventCount} 块 · ${localStatus.entityCount} 个概念`}
                  </span>
                </div>
                <div className="nb-storage-kv-item">
                  <span className="nb-storage-kv-key">最近索引同步</span>
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
                <Trash2 size={14} /> 彻底删除残留 kb_index.db
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
              <div className="nb-settings-label">同步索引侧栏挂载的本地文件夹</div>
              <div className="nb-settings-sub">
                自动将侧栏挂载目录里的 Markdown 与代码文本纳管进知识库检索（只读建索引，绝不修改原文件）
              </div>
            </div>
            <button
              type="button"
              className={`nb-toggle-switch${localStatus.includeFolders ? " is-on" : ""}`}
              disabled={busyAction !== null}
              onClick={handleToggleFolders}
              aria-label="同步索引侧栏挂载的本地文件夹"
            />
          </div>

          <div className="nb-menu-divider" />

          <div className="nb-settings-toggle-row">
            <div>
              <div className="nb-settings-label">编辑器右侧显示「关联知识」面板</div>
              <div className="nb-settings-sub">
                撰写笔记时自动在右侧呈现与当前内容存在共同概念关联的历史笔记、本地文件及可跳转卡片
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
              {busyAction === "inc-rebuild" ? "同步中..." : "增量同步索引"}
            </button>
            <button
              type="button"
              className="nb-btn-secondary"
              disabled={busyAction !== null}
              onClick={() => handleRebuild(true)}
            >
              <Database size={14} />
              {busyAction === "full-rebuild" ? "重建中..." : "全量重建索引"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
