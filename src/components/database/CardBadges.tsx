import React from "react";
import { Calendar, Check, ExternalLink, Hash } from "lucide-react";
import type { DbColumn, DbRow } from "../../types/notion";
import {
  findSelectOption,
  formatDateFriendly,
  isCellEmpty,
  isCheckboxChecked,
  normalizeExternalUrl,
  normalizeOptionColor,
  resolveMultiSelectOptions,
} from "./dbUtils";

export interface CardBadgesProps {
  row: DbRow;
  columns: DbColumn[];
  excludeColIds?: string[];
  onToggleCheckbox?: (rowId: string, colId: string, nextVal: boolean) => void;
}

export const CardBadges: React.FC<CardBadgesProps> = ({
  row,
  columns,
  excludeColIds = [],
  onToggleCheckbox,
}) => {
  const excluded = new Set(excludeColIds);
  const badgeNodes: React.ReactNode[] = [];

  for (const col of columns) {
    if (col.colType === "title" || excluded.has(col.id)) continue;
    const raw = row.cells[col.id];

    if (col.colType === "checkbox") {
      const checked = isCheckboxChecked(raw);
      if (!checked && !onToggleCheckbox) continue;
      // Show checked checkboxes prominently, or allow toggling if non-empty/checked
      if (checked) {
        badgeNodes.push(
          <button
            key={col.id}
            type="button"
            className="nb-db-card-badge nb-db-card-badge-check is-checked"
            onClick={(e) => {
              if (onToggleCheckbox) {
                e.stopPropagation();
                onToggleCheckbox(row.id, col.id, false);
              }
            }}
            title={`${col.name}: 已完成（点击切换）`}
          >
            <span className="nb-db-mini-check">
              <Check size={10} strokeWidth={3} />
            </span>
            <span>{col.name}</span>
          </button>
        );
      }
      continue;
    }

    if (isCellEmpty(col, raw)) continue;

    if (col.colType === "status" || col.colType === "select") {
      const opt = findSelectOption(col, raw, true);
      if (!opt) continue;
      badgeNodes.push(
        <span
          key={col.id}
          className={`nb-db-pill nb-db-pill-${normalizeOptionColor(opt.color)}`}
          title={`${col.name}: ${opt.label}`}
        >
          {col.colType === "status" && <span className="nb-db-pill-dot" />}
          <span>{opt.label}</span>
        </span>
      );
      continue;
    }

    if (col.colType === "multi_select") {
      const opts = resolveMultiSelectOptions(col, raw);
      for (const opt of opts) {
        badgeNodes.push(
          <span
            key={`${col.id}_${opt.id}`}
            className={`nb-db-pill nb-db-pill-${normalizeOptionColor(
              opt.color
            )}`}
            title={`${col.name}: ${opt.label}`}
          >
            <span>{opt.label}</span>
          </span>
        );
      }
      continue;
    }

    if (col.colType === "date") {
      const formatted = formatDateFriendly(raw);
      if (!formatted) continue;
      badgeNodes.push(
        <span
          key={col.id}
          className="nb-db-card-badge"
          title={`${col.name}: ${formatted}`}
        >
          <Calendar size={12} />
          <span>{formatted}</span>
        </span>
      );
      continue;
    }

    if (col.colType === "number") {
      badgeNodes.push(
        <span
          key={col.id}
          className="nb-db-card-badge"
          title={`${col.name}: ${String(raw)}`}
        >
          <Hash size={11} />
          <span>
            {col.name}: {String(raw)}
          </span>
        </span>
      );
      continue;
    }

    if (col.colType === "url") {
      const href = normalizeExternalUrl(String(raw));
      badgeNodes.push(
        <a
          key={col.id}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="nb-db-card-badge nb-db-card-badge-link"
          onClick={(e) => e.stopPropagation()}
          title={href}
        >
          <ExternalLink size={11} />
          <span>{col.name}</span>
        </a>
      );
      continue;
    }

    if (col.colType === "text") {
      badgeNodes.push(
        <span
          key={col.id}
          className="nb-db-card-badge nb-db-card-badge-text"
          title={`${col.name}: ${String(raw)}`}
        >
          {String(raw)}
        </span>
      );
    }
  }

  if (badgeNodes.length === 0) return null;

  return <div className="nb-db-card-badges">{badgeNodes}</div>;
};
