import React, { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  FileCode2,
  Link2,
  Network,
  RefreshCw,
  Settings,
  X,
} from "lucide-react";
import { kbEntityEvents, kbRelatedForContext } from "../../api/kb";
import { PageIcon } from "../../icons/pageIcon";
import type { KbEntitySummary, KbSearchHit } from "../../types/notion";

export interface KbRelatedPanelProps {
  sourceKind: "workspace_page" | "mounted_file" | null;
  refId: string | null;
  title: string;
  contentText: string;
  sourceCount: number;
  entityCount: number;
  onOpenPage: (pageId: string, blockId: string | null) => void;
  onOpenFile: (filePath: string) => void;
  onCopyWikiLink: (title: string) => void;
  onOpenSettings: () => void;
  onClose: () => void;
}

export const KbRelatedPanel: React.FC<KbRelatedPanelProps> = ({
  sourceKind,
  refId,
  title,
  contentText,
  sourceCount,
  entityCount,
  onOpenPage,
  onOpenFile,
  onCopyWikiLink,
  onOpenSettings,
  onClose,
}) => {
  const [entities, setEntities] = useState<KbEntitySummary[]>([]);
  const [hits, setHits] = useState<KbSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [focusedEntity, setFocusedEntity] = useState<string | null>(null);
  const [entityHits, setEntityHits] = useState<KbSearchHit[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);

  // 切换文档时清除概念追踪子视图
  useEffect(() => {
    setFocusedEntity(null);
    setEntityHits([]);
  }, [sourceKind, refId]);

  // 实时计算当前笔记的 SAG2 动态超边关联推荐（420ms 防抖）
  useEffect(() => {
    if (!sourceKind || !refId) {
      setEntities([]);
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      kbRelatedForContext(sourceKind, refId, title, contentText, 8)
        .then((res) => {
          if (cancelled) return;
          setEntities(res.contextEntities);
          setHits(res.hits);
          setElapsedMs(res.elapsedMs);
        })
        .catch(() => {
          if (!cancelled) {
            setEntities([]);
            setHits([]);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 420);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sourceKind, refId, title, contentText, refreshTick]);

  const openEntityTrace = useCallback((name: string) => {
    setFocusedEntity(name);
    setLoading(true);
    kbEntityEvents(name, 30)
      .then((res) => setEntityHits(res))
      .catch(() => setEntityHits([]))
      .finally(() => setLoading(false));
  }, []);

  const handleOpenHit = useCallback(
    (hit: KbSearchHit) => {
      if (hit.sourceKind === "workspace_page") {
        onOpenPage(hit.refId, hit.blockId);
      } else {
        onOpenFile(hit.refId);
      }
    },
    [onOpenFile, onOpenPage]
  );

  const visibleHits = focusedEntity ? entityHits : hits;

  return (
    <aside className="nb-kb-panel" aria-label="SAG2 关联知识面板">
      <div className="nb-kb-panel-header">
        <div className="nb-kb-panel-title-wrap">
          <Network size={15} />
          <span className="nb-kb-panel-title">关联知识</span>
          <span className="nb-kb-badge">SAG2</span>
        </div>
        <div className="nb-kb-panel-actions">
          <button
            type="button"
            className="nb-icon-btn"
            onClick={() => {
              if (focusedEntity) {
                openEntityTrace(focusedEntity);
              } else {
                setRefreshTick((t) => t + 1);
              }
            }}
            title="刷新关联推荐"
          >
            <RefreshCw size={13} />
          </button>
          <button
            type="button"
            className="nb-icon-btn"
            onClick={onOpenSettings}
            title="知识库引擎设置"
          >
            <Settings size={13} />
          </button>
          <button
            type="button"
            className="nb-icon-btn"
            onClick={onClose}
            title="隐藏关联知识面板"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="nb-kb-panel-sub">
        <span>{`已索引 ${sourceCount} 篇 · ${entityCount} 个概念`}</span>
        {elapsedMs > 0 && !focusedEntity && <span>{elapsedMs} ms</span>}
      </div>

      {focusedEntity ? (
        <div className="nb-kb-trace-bar">
          <button
            type="button"
            className="nb-kb-back-btn"
            onClick={() => setFocusedEntity(null)}
          >
            <ArrowLeft size={13} />
            <span>返回关联推荐</span>
          </button>
          <span className="nb-kb-trace-name" title={focusedEntity}>
            {`概念追踪：${focusedEntity}`}
          </span>
        </div>
      ) : (
        entities.length > 0 && (
          <div className="nb-kb-section">
            <div className="nb-kb-section-label">当前笔记概念（点击追踪时间线）</div>
            <div className="nb-kb-chips">
              {entities.map((ent) => (
                <button
                  key={ent.name}
                  type="button"
                  className="nb-kb-chip"
                  onClick={() => openEntityTrace(ent.name)}
                  title={`跨 ${ent.docFreq} 篇文档出现，点击查看全部提及`}
                >
                  <span>{ent.name}</span>
                  <span className="nb-kb-chip-df">{ent.docFreq}</span>
                </button>
              ))}
            </div>
          </div>
        )
      )}

      <div className="nb-kb-list">
        {!sourceKind || !refId ? (
          <div className="nb-kb-empty">
            打开任意工作区页面或磁盘笔记，SAG2 将在此自动浮现跨文档概念关联。
          </div>
        ) : loading && visibleHits.length === 0 ? (
          <div className="nb-kb-empty">正在通过动态超边检索关联内容…</div>
        ) : visibleHits.length === 0 ? (
          <div className="nb-kb-empty">
            {focusedEntity
              ? "未找到该概念在其它文档中的记录。"
              : "暂未发现其它文档与当前内容共享概念，继续写作或点击设置执行全量同步即可自动串联。"}
          </div>
        ) : (
          visibleHits.map((hit) => (
            <div
              key={hit.eventId}
              className="nb-kb-card"
              role="button"
              tabIndex={0}
              onClick={() => handleOpenHit(hit)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleOpenHit(hit);
                }
              }}
              title={hit.refId}
            >
              <div className="nb-kb-card-top">
                <span className="nb-kb-card-icon">
                  {hit.sourceKind === "workspace_page" ? (
                    <PageIcon icon={hit.icon || "📄"} size={14} />
                  ) : (
                    <FileCode2 size={14} />
                  )}
                </span>
                <span className="nb-kb-card-title">{hit.title || "无标题"}</span>
                {hit.sourceKind === "workspace_page" ? (
                  <button
                    type="button"
                    className="nb-kb-copy-btn"
                    title="复制 [[双链]]"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCopyWikiLink(hit.title || "无标题");
                    }}
                  >
                    <Link2 size={12} />
                    <span>双链</span>
                  </button>
                ) : (
                  hit.rootName && <span className="nb-kb-root-tag">{hit.rootName}</span>
                )}
              </div>

              {(hit.headingPath || hit.lineStart) && (
                <div className="nb-kb-card-meta">
                  {hit.headingPath && <span>{hit.headingPath}</span>}
                  {hit.lineStart && <span>{`第 ${hit.lineStart} 行`}</span>}
                </div>
              )}

              {hit.snippet && <div className="nb-kb-card-snippet">{hit.snippet}</div>}

              {hit.sharedEntities.length > 0 && (
                <div className="nb-kb-bridge-row">
                  {hit.sharedEntities.map((entName) => (
                    <button
                      key={entName}
                      type="button"
                      className="nb-kb-bridge-pill"
                      onClick={(e) => {
                        e.stopPropagation();
                        openEntityTrace(entName);
                      }}
                      title="点击追踪此关联概念"
                    >
                      {`关联：${entName}`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
};
