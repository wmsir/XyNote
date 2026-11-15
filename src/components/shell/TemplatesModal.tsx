import React, { useCallback, useEffect, useRef, useState } from "react";
import { Download, FilePlus2, RefreshCw, Sparkles, Trash2, Upload, X } from "lucide-react";
import {
  deleteCustomTemplate,
  importCustomTemplates,
  listCustomTemplates,
  savePageAsTemplate,
  TEMPLATE_FILE_SCHEMA,
  templatePreviewLines,
  updateCustomTemplate,
  type CustomTemplate,
} from "../../api/templates";
import { PageIcon } from "../../icons/pageIcon";
import { IconPicker } from "./IconPicker";
import type { CreatePageInput, PageType } from "../../types/notion";

interface TemplateDefinition {
  id: string;
  title: string;
  icon: string;
  pageType: PageType;
  category: string;
  summary: string;
  bullets: string[];
}

const TEMPLATES: TemplateDefinition[] = [
  {
    id: "meeting-notes",
    title: "团队周会纪要",
    icon: "📝",
    pageType: "doc",
    category: "文档模板",
    summary: "结构化记录参会人员、核心议程讨论结论与可追踪的待办行动项。",
    bullets: [
      "📅 顶部参会信息与日期标注栏 (Callout)",
      "📌 核心议程与关键决议无序列表",
      "✅ 负责人明确的复选待办清单 (Todo)",
    ],
  },
  {
    id: "product-roadmap",
    title: "产品路线图",
    icon: "🗺️",
    pageType: "database",
    category: "数据库模板",
    summary: "覆盖需求规划、研发进度、优先级分级与目标上线日期的多维数据库。",
    bullets: [
      "📊 预置表格、看板、画廊三种视图随时切换",
      "🏷️ 内置状态 (Todo / 进行中 / 已完成) 与 P0-P2 优先级标签",
      "🔗 每一行记录均可一键展开为完整子文档页面",
    ],
  },
  {
    id: "task-hub",
    title: "任务管理看板",
    icon: "✅",
    pageType: "database",
    category: "数据库模板",
    summary: "敏捷个人与团队任务面板，支持拖拽卡片跨列流转更新任务状态。",
    bullets: [
      "🗂️ 默认开启看板分组视图，直观呈现待办与进行中事项",
      "🔍 支持按状态、优先级快速筛选与排序",
      "⚡ 底部自动统计完成率与任务计数",
    ],
  },
  {
    id: "eng-spec",
    title: "技术方案设计 RFC",
    icon: "⚙️",
    pageType: "doc",
    category: "文档模板",
    summary: "适用于架构演进、接口契约评审、核心代码示意与风险评估。",
    bullets: [
      "🛠️ 评审状态提示块与背景目标拆解",
      "💻 内置语法代码块与架构接口示例",
      "📋 风险等级与回滚预案对比表格",
    ],
  },
  {
    id: "reading-list",
    title: "阅读书单与笔记",
    icon: "📚",
    pageType: "database",
    category: "数据库模板",
    summary: "沉淀书籍、深度长文与技术论文阅读进度及星级推荐指数。",
    bullets: [
      "🖼️ 预置画廊卡片视图与在读状态管理",
      "⭐ 五星推荐度单选属性与完成归档标记",
      "📝 点击任意书目可关联深度读书笔记子页面",
    ],
  },
  {
    id: "weekly-journal",
    title: "每周复盘与计划",
    icon: "🗓️",
    pageType: "doc",
    category: "文档模板",
    summary: "用简洁清晰的周度回顾框架梳理本周高光收获、反思与下周聚焦事项。",
    bullets: [
      "✨ 本周高光成果 Wins 记录区",
      "🧩 挑战反思引用块与经验沉淀",
      "🎯 下周最重要的三件事 (Top 3 Todos)",
    ],
  },
];

export interface TemplatesModalProps {
  open: boolean;
  onClose: () => void;
  onUseTemplate: (input: CreatePageInput) => void;
  /** 当前打开的页面（可以存为模板） */
  currentPage?: { id: string; title: string } | null;
  onNotify?: (msg: string, ms?: number) => void;
  /** 打开时直接选中的「我的模板」 */
  focusTemplateId?: string | null;
}

type Selection = { kind: "builtin"; id: string } | { kind: "custom"; id: string };

function downloadJson(name: string, data: unknown) {
  try {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    /* 无法下载时忽略 */
  }
}

const errText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^(Not found|Validation error): /, "");

export const TemplatesModal: React.FC<TemplatesModalProps> = ({
  open,
  onClose,
  onUseTemplate,
  currentPage = null,
  onNotify = () => {},
  focusTemplateId = null,
}) => {
  const [selection, setSelection] = useState<Selection>({ kind: "builtin", id: TEMPLATES[0].id });
  const [mine, setMine] = useState<CustomTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const [draft, setDraft] = useState({ title: "", description: "" });
  const importRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await listCustomTemplates();
      setMine(list);
      return list;
    } catch (e) {
      onNotify(`读取我的模板失败：${errText(e)}`);
      return [];
    }
  }, [onNotify]);

  useEffect(() => {
    if (!open) return;
    void reload().then((list) => {
      if (focusTemplateId && list.some((t) => t.id === focusTemplateId)) {
        setSelection({ kind: "custom", id: focusTemplateId });
      }
    });
  }, [open, focusTemplateId, reload]);

  const custom = selection.kind === "custom" ? mine.find((t) => t.id === selection.id) ?? null : null;

  useEffect(() => {
    if (custom) setDraft({ title: custom.title, description: custom.description });
    setIconOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custom?.id]);

  if (!open) return null;

  const builtin = TEMPLATES.find((t) => selection.kind === "builtin" && t.id === selection.id) ?? (custom ? null : TEMPLATES[0]);

  const replaceInList = (t: CustomTemplate) => setMine((list) => list.map((x) => (x.id === t.id ? t : x)));

  const saveMeta = async (patch: { title?: string; icon?: string; description?: string }) => {
    if (!custom) return;
    try {
      replaceInList(await updateCustomTemplate(custom.id, patch));
    } catch (e) {
      onNotify(`保存失败：${errText(e)}`);
    }
  };

  const saveCurrentAsNew = async () => {
    if (!currentPage) return;
    setBusy(true);
    try {
      const t = await savePageAsTemplate(currentPage.id);
      await reload();
      setSelection({ kind: "custom", id: t.id });
      onNotify(`已把「${t.title}」存为模板，可以在右侧修改名称和说明`);
    } catch (e) {
      onNotify(`存为模板失败：${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const updateFromCurrent = async () => {
    if (!custom || !currentPage) return;
    if (!window.confirm(`用当前页面「${currentPage.title || "无标题"}」的内容替换模板「${custom.title}」的内容吗？`)) return;
    setBusy(true);
    try {
      replaceInList(await savePageAsTemplate(currentPage.id, { title: custom.title, icon: custom.icon, description: custom.description }, custom.id));
      onNotify("模板内容已更新");
    } catch (e) {
      onNotify(`更新失败：${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const removeCustom = async () => {
    if (!custom) return;
    if (!window.confirm(`删除模板「${custom.title}」？已经用它创建的页面不受影响。`)) return;
    try {
      await deleteCustomTemplate(custom.id);
      const list = await reload();
      setSelection(list[0] ? { kind: "custom", id: list[0].id } : { kind: "builtin", id: TEMPLATES[0].id });
      onNotify("模板已删除");
    } catch (e) {
      onNotify(`删除失败：${errText(e)}`);
    }
  };

  const exportTemplates = (items: CustomTemplate[], name: string) => {
    downloadJson(name, { schema: TEMPLATE_FILE_SCHEMA, exportedAt: new Date().toISOString(), templates: items });
    onNotify(`已导出 ${items.length} 个模板`);
  };

  const onImportPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const items: CustomTemplate[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.templates) ? parsed.templates : [];
      if (items.length === 0) throw new Error("文件里没有模板");
      const n = await importCustomTemplates(items);
      await reload();
      onNotify(`已导入 ${n} 个模板`);
    } catch (err) {
      onNotify(`导入失败：${errText(err)}`, 3600);
    }
  };

  const useSelected = () => {
    if (custom) {
      onUseTemplate({ title: custom.title, icon: custom.icon, pageType: custom.pageType, templateId: `custom:${custom.id}` });
    } else if (builtin) {
      onUseTemplate({ title: builtin.title, icon: builtin.icon, pageType: builtin.pageType, templateId: builtin.id });
    }
    onClose();
  };

  return (
    <div className="nb-modal-backdrop" onMouseDown={onClose}>
      <div className="nb-modal-card is-wide" onMouseDown={(e) => e.stopPropagation()}>
        <input ref={importRef} type="file" accept=".json,application/json" hidden onChange={onImportPicked} />
        <div className="nb-modal-header">
          <div className="nb-modal-title">
            <Sparkles size={17} />
            <span>模板中心</span>
          </div>
          <div className="nb-tpl-head-actions">
            <button type="button" className="nb-btn-secondary nb-tpl-small-btn" onClick={() => importRef.current?.click()} title="从 .json 文件导入模板">
              <Upload size={13} /> 导入
            </button>
            <button
              type="button"
              className="nb-btn-secondary nb-tpl-small-btn"
              disabled={mine.length === 0}
              onClick={() => exportTemplates(mine, "xynote-templates.json")}
              title="把我的全部模板导出为 .json 文件"
            >
              <Download size={13} /> 导出全部
            </button>
            <button type="button" className="nb-icon-btn" onClick={onClose} aria-label="关闭">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="nb-tpl-body">
          <div className="nb-tpl-sidebar">
            <div className="nb-tpl-group-label">我的模板{mine.length ? `（${mine.length}）` : ""}</div>
            <button
              type="button"
              className="nb-tpl-nav-btn nb-tpl-save-btn"
              disabled={!currentPage || busy}
              onClick={() => void saveCurrentAsNew()}
              title={currentPage ? `把「${currentPage.title || "无标题"}」存为模板` : "先打开一个页面，再把它存为模板"}
            >
              <FilePlus2 size={16} />
              <span>把当前页面存为模板</span>
            </button>
            {mine.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`nb-tpl-nav-btn${custom?.id === t.id ? " is-selected" : ""}`}
                onClick={() => setSelection({ kind: "custom", id: t.id })}
              >
                <PageIcon icon={t.icon} size={17} className="nb-inline-page-icon" />
                <div className="nb-tpl-nav-text">
                  <div className="nb-tpl-nav-title">{t.title}</div>
                  <div className="nb-tpl-nav-sub">{t.pageType === "database" ? "数据库模板" : "文档模板"}</div>
                </div>
              </button>
            ))}

            <div className="nb-tpl-group-label">内置模板</div>
            {TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                className={`nb-tpl-nav-btn${builtin?.id === tpl.id ? " is-selected" : ""}`}
                onClick={() => setSelection({ kind: "builtin", id: tpl.id })}
              >
                <span style={{ fontSize: "17px" }}>{tpl.icon}</span>
                <div className="nb-tpl-nav-text">
                  <div className="nb-tpl-nav-title">{tpl.title}</div>
                  <div className="nb-tpl-nav-sub">{tpl.category}</div>
                </div>
              </button>
            ))}
          </div>

          <div className="nb-tpl-preview">
            {custom ? (
              <div>
                <div className="nb-tpl-custom-head">
                  <div style={{ position: "relative" }}>
                    <button type="button" className="nb-tpl-icon-btn" onClick={() => setIconOpen((v) => !v)} title="更换图标">
                      <PageIcon icon={custom.icon} size={34} strokeWidth={1.6} />
                    </button>
                    {iconOpen && (
                      <IconPicker
                        value={custom.icon}
                        allowRemove={false}
                        style={{ position: "absolute", left: 0, top: "52px" }}
                        onClose={() => setIconOpen(false)}
                        onChange={(icon, opts) => {
                          if (icon) void saveMeta({ icon });
                          if (!opts?.keepOpen) setIconOpen(false);
                        }}
                      />
                    )}
                  </div>
                  <div className="nb-tpl-custom-fields">
                    <input
                      className="nb-tpl-title-input"
                      value={draft.title}
                      maxLength={80}
                      aria-label="模板名称"
                      onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                      onBlur={() => draft.title.trim() && draft.title !== custom.title && void saveMeta({ title: draft.title })}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                    <span className="nb-tpl-nav-sub">
                      {custom.pageType === "database" ? "数据库模板" : "文档模板"} · 更新于 {custom.updatedAt.slice(0, 10)}
                    </span>
                  </div>
                </div>
                <textarea
                  className="nb-tpl-desc-input"
                  value={draft.description}
                  maxLength={300}
                  rows={2}
                  placeholder="写一句说明：这个模板适合做什么（选填）"
                  aria-label="模板说明"
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                  onBlur={() => draft.description !== custom.description && void saveMeta({ description: draft.description })}
                />
                <div className="nb-tpl-preview-box">
                  <div className="nb-tpl-preview-label">内容预览</div>
                  {templatePreviewLines(custom).length === 0 ? (
                    <div className="nb-tpl-nav-sub">（空白页面）</div>
                  ) : (
                    templatePreviewLines(custom).map((line, i) => (
                      <div key={i} className="nb-tpl-preview-line">
                        {line}
                      </div>
                    ))
                  )}
                </div>
                <div className="nb-tpl-custom-tools">
                  <button
                    type="button"
                    className="nb-btn-secondary nb-tpl-small-btn"
                    disabled={!currentPage || busy}
                    onClick={() => void updateFromCurrent()}
                    title={currentPage ? "用当前打开的页面替换模板内容" : "先打开一个页面"}
                  >
                    <RefreshCw size={13} /> 用当前页面更新
                  </button>
                  <button type="button" className="nb-btn-secondary nb-tpl-small-btn" onClick={() => exportTemplates([custom], `${custom.title}.xynote-template.json`)}>
                    <Download size={13} /> 导出
                  </button>
                  <button type="button" className="nb-btn-secondary nb-tpl-small-btn is-danger" onClick={() => void removeCustom()}>
                    <Trash2 size={13} /> 删除
                  </button>
                </div>
              </div>
            ) : builtin ? (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "10px" }}>
                  <span style={{ fontSize: "38px", lineHeight: 1 }}>{builtin.icon}</span>
                  <div>
                    <h3 style={{ margin: 0, fontSize: "20px", fontWeight: 700 }}>{builtin.title}</h3>
                    <span style={{ fontSize: "12px", color: "var(--text-tertiary)" }}>{builtin.category}</span>
                  </div>
                </div>
                <p style={{ color: "var(--text-secondary)", fontSize: "14px", margin: "12px 0 18px" }}>{builtin.summary}</p>
                <div className="nb-tpl-preview-box">
                  <div className="nb-tpl-preview-label">包含内容</div>
                  {builtin.bullets.map((line) => (
                    <div key={line} className="nb-tpl-preview-line">
                      {line}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button type="button" className="nb-btn-secondary" onClick={onClose}>
                取消
              </button>
              <button type="button" className="nb-btn-primary" onClick={useSelected}>
                用这个模板新建页面
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
