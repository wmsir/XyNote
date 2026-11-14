import React, { useState } from "react";
import { Sparkles, X } from "lucide-react";
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
}

export const TemplatesModal: React.FC<TemplatesModalProps> = ({
  open,
  onClose,
  onUseTemplate,
}) => {
  const [selectedId, setSelectedId] = useState<string>(TEMPLATES[0].id);

  if (!open) return null;

  const selected = TEMPLATES.find((t) => t.id === selectedId) ?? TEMPLATES[0];

  return (
    <div className="nb-modal-backdrop" onMouseDown={onClose}>
      <div
        className="nb-modal-card is-wide"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="nb-modal-header">
          <div className="nb-modal-title">
            <Sparkles size={17} />
            <span>模板中心 Templates</span>
          </div>
          <button type="button" className="nb-icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="nb-tpl-body">
          <div className="nb-tpl-sidebar">
            {TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                className={`nb-tpl-nav-btn${
                  tpl.id === selected.id ? " is-selected" : ""
                }`}
                onClick={() => setSelectedId(tpl.id)}
              >
                <span style={{ fontSize: "17px" }}>{tpl.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {tpl.title}
                  </div>
                  <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                    {tpl.category}
                  </div>
                </div>
              </button>
            ))}
          </div>

          <div className="nb-tpl-preview">
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  marginBottom: "10px",
                }}
              >
                <span style={{ fontSize: "38px", lineHeight: 1 }}>
                  {selected.icon}
                </span>
                <div>
                  <h3 style={{ margin: 0, fontSize: "20px", fontWeight: 700 }}>
                    {selected.title}
                  </h3>
                  <span style={{ fontSize: "12px", color: "var(--text-tertiary)" }}>
                    {selected.category} · 一键生成结构与示例内容
                  </span>
                </div>
              </div>

              <p
                style={{
                  color: "var(--text-secondary)",
                  fontSize: "14px",
                  margin: "12px 0 18px",
                }}
              >
                {selected.summary}
              </p>

              <div className="nb-tpl-preview-box">
                <div
                  style={{
                    fontSize: "12px",
                    fontWeight: 600,
                    color: "var(--text-tertiary)",
                  }}
                >
                  包含模块预览
                </div>
                {selected.bullets.map((line) => (
                  <div
                    key={line}
                    style={{ fontSize: "13.5px", color: "var(--text-primary)" }}
                  >
                    {line}
                  </div>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button type="button" className="nb-btn-secondary" onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="nb-btn-primary"
                onClick={() => {
                  onUseTemplate({
                    title: selected.title,
                    icon: selected.icon,
                    pageType: selected.pageType,
                    templateId: selected.id,
                  });
                  onClose();
                }}
              >
                使用此模板创建页面
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
