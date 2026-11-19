import React, { useCallback, useEffect, useRef, useState } from "react";
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
  const traceSeqRef = useRef(0);

  // 切换文档时清除概念追踪子视图并作废在途概念追踪请求
  useEffect(() => {
    traceSeqRef.current += 1;
    setFocusedEntity(null);
    setEntityHits([]);
    setLoading(false);
    return () => {
      traceSeqRef.current += 1;
    };
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
    const seq = ++traceSeqRef.current;
    setFocusedEntity(name);
    setLoading(true);
    kbEntityEvents(name, 30)
      .then((res) => {
        if (seq === traceSeqRef.current) setEntityHits(res);
      })
      .catch(() => {
        if (seq === traceSeqRef.current) setEntityHits([]);
      })
      .finally(() => {
        if (seq === traceSeqRef.current) setLoading(false);
      });
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
    <aside className="nb-kb-panel" aria-label="关联知识面板">
      <div className="nb-kb-panel-header">
        <div className="nb-kb-panel-title-wrap">
          <Network size={15} />
          <span className="nb-kb-panel-title">关联知识</span>
          <span className="nb-kb-badge">智能</span>
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
            title="本地知识库设置"
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
        <span>{`已收录 ${sourceCount} 篇 · ${entityCount} 个主题`}</span>
        {elapsedMs > 0 && !focusedEntity && <span>{elapsedMs} ms</span>}
      </div>

      {focusedEntity ? (
        <div className="nb-kb-trace-bar">
          <button
            type="button"
            className="nb-kb-back-btn"
            onClick={() => {
              traceSeqRef.current += 1;
              setFocusedEntity(null);
              setLoading(false);
            }}
          >
            <ArrowLeft size={13} />
            <span>返回关联推荐</span>
          </button>
          <span className="nb-kb-trace-name" title={focusedEntity}>
            {`主题线索：${focusedEntity}`}
          </span>
        </div>
      ) : (
        entities.length > 0 && (
          <div className="nb-kb-section">
            <div className="nb-kb-section-label">当前笔记主题词（点击查看相关记录）</div>
            <div className="nb-kb-chips">
              {entities.map((ent) => (
                <button
                  key={ent.name}
                  type="button"
                  className="nb-kb-chip"
                  onClick={() => openEntityTrace(ent.name)}
                  title={`在 ${ent.docFreq} 篇笔记中出现，点击查看全部提及`}
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
            打开任意工作区页面或本地笔记，这里会自动推荐相关的历史内容。
          </div>
        ) : loading && visibleHits.length === 0 ? (
          <div className="nb-kb-empty">正在查找相关笔记…</div>
        ) : visibleHits.length === 0 ? (
          <div className="nb-kb-empty">
            {focusedEntity
              ? "未找到该主题在其他笔记中的记录。"
              : "暂未发现其他相关笔记，继续写作或在设置中更新索引后会自动关联。"}
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
                      title="点击查看此主题的相关笔记"
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
