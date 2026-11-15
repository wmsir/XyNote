import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Download,
  Keyboard,
  RotateCcw,
  Search,
  Upload,
} from "lucide-react";
import type { KeybindingMap } from "../../types/notion";
import {
  DEFAULT_KEYBINDINGS,
  extractKeybindingOverrides,
  findConflictingActions,
  formatShortcutBadge,
  KEYBINDING_CATEGORY_TABS,
  KEYBINDING_DEFINITIONS,
  KeybindingCategory,
  KeybindingDefinition,
  mergeKeybindings,
  normalizeKeyboardEventToShortcut,
  normalizeTextEditorShortcut,
  applyTextPreset,
  defaultShortcutFor,
  textPresetOf,
  TEXT_KEYMAP_PRESETS,
  type TextKeymapPreset,
} from "./keybindingRegistry";

export interface KeybindingSettingsPanelProps {
  keybindings: KeybindingMap;
  onChangeKeybindings: (nextMerged: KeybindingMap) => void;
  onNotify: (msg: string) => void;
}

interface PendingConflictState {
  targetAction: KeybindingDefinition;
  candidateCombo: string;
  conflicts: KeybindingDefinition[];
}

export const KeybindingSettingsPanel: React.FC<KeybindingSettingsPanelProps> = ({
  keybindings,
  onChangeKeybindings,
  onNotify,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<
    "all" | KeybindingCategory
  >("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [recordingActionId, setRecordingActionId] = useState<string | null>(null);
  const [pendingConflict, setPendingConflict] =
    useState<PendingConflictState | null>(null);

  const importFileInputRef = useRef<HTMLInputElement | null>(null);

  const mergedMap = useMemo(
    () => mergeKeybindings(keybindings),
    [keybindings]
  );

  const customOverrideCount = useMemo(
    // 文本编辑器按所选方案（IDEA / VS Code）的默认值计算，换方案本身不算自定义
    () => KEYBINDING_DEFINITIONS.filter((d) => (mergedMap[d.id] ?? "") !== defaultShortcutFor(d, mergedMap)).length,
    [mergedMap]
  );

  const filteredActions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return KEYBINDING_DEFINITIONS.filter((def) => {
      if (selectedCategory !== "all" && def.category !== selectedCategory) {
        return false;
      }
      if (!q) return true;
      const bound = (mergedMap[def.id] ?? "").toLowerCase();
      const badge = formatShortcutBadge(mergedMap[def.id]).toLowerCase();
      return (
        def.label.toLowerCase().includes(q) ||
        def.description.toLowerCase().includes(q) ||
        def.id.toLowerCase().includes(q) ||
        def.categoryLabel.toLowerCase().includes(q) ||
        bound.includes(q) ||
        badge.includes(q)
      );
    });
  }, [mergedMap, searchQuery, selectedCategory]);

  // Capture-phase key recorder so Esc cancels recording without closing SettingsModal
  useEffect(() => {
    if (!recordingActionId) return;

    const targetDef = KEYBINDING_DEFINITIONS.find(
      (d) => d.id === recordingActionId
    );
    if (!targetDef) {
      setRecordingActionId(null);
      return;
    }

    const onKeyDownCapture = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setRecordingActionId(null);
        return;
      }

      if (
        (e.key === "Backspace" || e.key === "Delete") &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.shiftKey
      ) {
        const next = { ...mergedMap, [recordingActionId]: "" };
        onChangeKeybindings(next);
        setRecordingActionId(null);
        setPendingConflict(null);
        onNotify(`已清空「${targetDef.label}」的快捷键绑定`);
        return;
      }

      const combo = targetDef.category === "textEditor" ? normalizeTextEditorShortcut(e) : normalizeKeyboardEventToShortcut(e);
      if (!combo) {
        // Ignore lone modifier press or plain typing key without Ctrl/Alt
        return;
      }

      const conflicts = findConflictingActions(
        mergedMap,
        recordingActionId,
        combo
      );
      if (conflicts.length > 0) {
        setPendingConflict({
          targetAction: targetDef,
          candidateCombo: combo,
          conflicts,
        });
        setRecordingActionId(null);
        return;
      }

      const next = { ...mergedMap, [recordingActionId]: combo };
      onChangeKeybindings(next);
      setRecordingActionId(null);
      setPendingConflict(null);
      onNotify(`已将「${targetDef.label}」绑定为 ${formatShortcutBadge(combo)}`);
    };

    window.addEventListener("keydown", onKeyDownCapture, true);
    return () => window.removeEventListener("keydown", onKeyDownCapture, true);
  }, [mergedMap, onChangeKeybindings, onNotify, recordingActionId]);

  const handleResolveOverride = () => {
    if (!pendingConflict) return;
    const next = { ...mergedMap };
    for (const c of pendingConflict.conflicts) {
      next[c.id] = "";
    }
    next[pendingConflict.targetAction.id] = pendingConflict.candidateCombo;
    onChangeKeybindings(next);
    onNotify(
      `已将 ${formatShortcutBadge(pendingConflict.candidateCombo)} 绑定至「${
        pendingConflict.targetAction.label
      }」（已解绑原冲突项）`
    );
    setPendingConflict(null);
  };

  const handleResolveSwap = () => {
    if (!pendingConflict || pendingConflict.conflicts.length === 0) return;
    const prevCombo = mergedMap[pendingConflict.targetAction.id] ?? "";
    const primaryConflict = pendingConflict.conflicts[0];
    const next = { ...mergedMap };
    next[primaryConflict.id] = prevCombo;
    for (let i = 1; i < pendingConflict.conflicts.length; i++) {
      next[pendingConflict.conflicts[i].id] = "";
    }
    next[pendingConflict.targetAction.id] = pendingConflict.candidateCombo;
    onChangeKeybindings(next);
    onNotify(
      `已互换「${pendingConflict.targetAction.label}」与「${primaryConflict.label}」的快捷键`
    );
    setPendingConflict(null);
  };

  const handleResetSingle = (def: KeybindingDefinition) => {
    const next = { ...mergedMap, [def.id]: defaultShortcutFor(def, mergedMap) };
    onChangeKeybindings(next);
    if (pendingConflict?.targetAction.id === def.id) {
      setPendingConflict(null);
    }
    onNotify(`已恢复「${def.label}」默认快捷键`);
  };

  const handleResetAll = () => {
    // 保留文本编辑器所选的方案
    onChangeKeybindings(applyTextPreset({ ...DEFAULT_KEYBINDINGS }, textPresetOf(mergedMap)));
    setRecordingActionId(null);
    setPendingConflict(null);
    onNotify("已将全部快捷键恢复为出厂默认配置");
  };

  const handleExportJson = () => {
    const overrides = extractKeybindingOverrides(mergedMap);
    const payload = JSON.stringify(
      {
        schema: "xynote-keybindings-v1",
        version: "0.3.0",
        exportedAt: new Date().toISOString(),
        overrides,
        keybindings: mergedMap,
      },
      null,
      2
    );
    try {
      const blob = new Blob([payload], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "xynote-keybindings.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Ignore headless download restrictions
    }
    onNotify("快捷键配置已导出为 xynote-keybindings.json");
  };

  const handleImportJsonPicked = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const sourceMap =
        parsed.overrides && typeof parsed.overrides === "object"
          ? (parsed.overrides as KeybindingMap)
          : parsed.keybindings && typeof parsed.keybindings === "object"
          ? (parsed.keybindings as KeybindingMap)
          : (parsed as KeybindingMap);
      const next = mergeKeybindings(sourceMap);
      onChangeKeybindings(next);
      setPendingConflict(null);
      onNotify(`已成功导入快捷键配置：${file.name}`);
    } catch (err) {
      onNotify(
        `导入快捷键配置失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  return (
    <div className="nb-settings-section-stack">
      <input
        ref={importFileInputRef}
        type="file"
        accept=".json"
        style={{ display: "none" }}
        onChange={handleImportJsonPicked}
      />

      <div className="nb-settings-row-head">
        <div>
          <h3 className="nb-settings-heading">
            全量交互式快捷键配置中心 ({KEYBINDING_DEFINITIONS.length} 项)
          </h3>
          <p className="nb-settings-desc">
            支持自定义全部 18 种块级转换、块颜色高亮、块移动复制、行内排版与全局视图快捷键。点击任意快捷键胶囊即可实时按键录制。
          </p>
        </div>
      </div>

      {/* 文本 / 代码编辑器的快捷键方案 */}
      <div className="nb-settings-card-box nb-kb-preset">
        <div className="nb-kb-preset-text">
          <div className="nb-kb-preset-title">文本 / 代码编辑器的快捷键方案</div>
          <div className="nb-shortcut-desc">
            打开 txt、JSON、代码等文件时使用。选好方案后，下面「文本 / 代码编辑器」分类里的每一项都还可以单独修改。
          </div>
        </div>
        <div className="nb-kb-preset-btns" role="radiogroup" aria-label="快捷键方案">
          {(Object.keys(TEXT_KEYMAP_PRESETS) as TextKeymapPreset[]).map((id) => {
            const active = textPresetOf(mergedMap) === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                className={`nb-kb-cat-pill${active ? " is-active" : ""}`}
                onClick={() => {
                  onChangeKeybindings(applyTextPreset(mergedMap, id));
                  setSelectedCategory("textEditor");
                  onNotify(`文本编辑器已改用 ${TEXT_KEYMAP_PRESETS[id].label} 快捷键`);
                }}
              >
                {TEXT_KEYMAP_PRESETS[id].label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Toolbar: Category Filter Pills + Actions */}
      <div className="nb-kb-toolbar">
        <div className="nb-kb-cat-pills" role="tablist" aria-label="快捷键分类筛选">
          {KEYBINDING_CATEGORY_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`nb-kb-cat-pill${
                selectedCategory === tab.id ? " is-active" : ""
              }`}
              onClick={() => setSelectedCategory(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="nb-kb-actions-group">
          <button
            type="button"
            className="nb-btn-secondary"
            onClick={() => importFileInputRef.current?.click()}
            title="从 .json 文件导入快捷键方案"
          >
            <Upload size={13} /> 导入配置 (.json)
          </button>
          <button
            type="button"
            className="nb-btn-secondary"
            onClick={handleExportJson}
            title="导出当前快捷键方案供跨设备备份或分享"
          >
            <Download size={13} /> 导出配置 (.json)
          </button>
          <button
            type="button"
            className="nb-btn-secondary"
            disabled={customOverrideCount === 0}
            onClick={handleResetAll}
            title="将所有自定义过的快捷键恢复为默认值"
          >
            <RotateCcw size={13} /> 全部恢复默认
            {customOverrideCount > 0 ? ` (${customOverrideCount})` : ""}
          </button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="nb-shortcut-search-wrap">
        <Search size={15} style={{ color: "var(--text-tertiary)" }} />
        <input
          type="text"
          className="nb-cmd-input"
          placeholder="搜索动作名称、块类型、颜色或按键组合（如 Mermaid、提示块、黄色、Ctrl+1）..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Conflict Resolution Banner */}
      {pendingConflict && (
        <div className="nb-kb-conflict-banner" role="alert">
          <div className="nb-kb-conflict-main">
            <AlertTriangle size={16} className="nb-kb-conflict-icon" />
            <div>
              <div className="nb-kb-conflict-title">
                快捷键冲突检测：
                <kbd className="nb-kbd">
                  {formatShortcutBadge(pendingConflict.candidateCombo)}
                </kbd>{" "}
                已被「
                {pendingConflict.conflicts.map((c) => c.label).join("、")}」占用
              </div>
              <div className="nb-kb-conflict-desc">
                你想将它分配给「{pendingConflict.targetAction.label}」，请选择处理方式：
              </div>
            </div>
          </div>
          <div className="nb-kb-conflict-btns">
            <button
              type="button"
              className="nb-btn-primary"
              onClick={handleResolveOverride}
            >
              覆盖并解绑原操作
            </button>
            <button
              type="button"
              className="nb-btn-secondary"
              onClick={handleResolveSwap}
            >
              互换快捷键
            </button>
            <button
              type="button"
              className="nb-btn-secondary"
              onClick={() => setPendingConflict(null)}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Keybindings Table */}
      <div className="nb-shortcuts-table-wrap">
        <table className="nb-shortcuts-table nb-kb-recorder-table">
          <thead>
            <tr>
              <th style={{ width: "136px" }}>所属分类</th>
              <th>功能动作说明</th>
              <th style={{ width: "240px" }}>当前快捷键（点击录制）</th>
              <th style={{ width: "76px", textAlign: "right" }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {filteredActions.map((def) => {
              const currentCombo = mergedMap[def.id] ?? "";
              const isRecording = recordingActionId === def.id;
              const isModified = currentCombo !== defaultShortcutFor(def, mergedMap);
              return (
                <tr
                  key={def.id}
                  data-action-id={def.id}
                  className={isRecording ? "is-recording-row" : undefined}
                >
                  <td>
                    <span className="nb-shortcut-cat">{def.categoryLabel}</span>
                  </td>
                  <td>
                    <div className="nb-shortcut-action">
                      {def.label}
                      {isModified && (
                        <span className="nb-kb-modified-dot" title="已自定义修改">
                          已定制
                        </span>
                      )}
                    </div>
                    <div className="nb-shortcut-desc">{def.description}</div>
                  </td>
                  <td>
                    <button
                      type="button"
                      data-record-btn={def.id}
                      data-shortcut-combo={currentCombo}
                      className={`nb-kb-record-pill${
                        isRecording
                          ? " is-recording"
                          : !currentCombo
                          ? " is-unbound"
                          : ""
                      }`}
                      onClick={() => {
                        setPendingConflict(null);
                        setRecordingActionId(isRecording ? null : def.id);
                      }}
                      title="点击后直接按下新组合键（Esc 取消，Backspace 清空）"
                    >
                      <Keyboard size={12} />
                      <span>
                        {isRecording
                          ? "请按下快捷键… (Esc 取消 / Backspace 清空)"
                          : formatShortcutBadge(currentCombo)}
                      </span>
                    </button>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {isModified ? (
                      <button
                        type="button"
                        className="nb-link-btn"
                        onClick={() => handleResetSingle(def)}
                        title={`恢复默认 (${formatShortcutBadge(
                          def.defaultShortcut
                        )})`}
                      >
                        重置
                      </button>
                    ) : (
                      <span className="nb-kb-default-tag">默认</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
