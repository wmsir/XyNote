import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import type {
  ColumnType,
  DatabaseFull,
  DbColumn,
  DbRow,
  Page,
  SelectOption,
  UpsertDbColumnInput,
  UpsertDbRowInput,
} from "../../types/notion";
import {
  deleteDbColumn,
  deleteDbRow,
  getDatabase,
  updateDatabaseView,
  upsertDbColumn,
  upsertDbRow,
} from "../../api/client";
import {
  FilterRule,
  SortDirection,
  SortRule,
  ViewMode,
  applyFiltersAndSorts,
  generateLocalId,
  getDefaultOptionsForType,
  getRowTitle,
  getSortedColumns,
} from "./dbUtils";
import { FilterSortBar } from "./FilterSortBar";
import { TableView } from "./TableView";
import { BoardView } from "./BoardView";
import { GalleryView } from "./GalleryView";
import { CalendarView } from "./CalendarView";
import { TimelineView } from "./TimelineView";
import { RowDetailDrawer } from "./RowDetailDrawer";
import "./database.css";

export interface DatabaseViewProps {
  pageId: string;
  pages: Page[];
  onOpenPage: (pageId: string) => void;
  onCreateLinkedPage?: (title: string, parentId: string) => Promise<Page>;
}

export const DatabaseView: React.FC<DatabaseViewProps> = ({
  pageId,
  pages,
  onOpenPage,
  onCreateLinkedPage,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);

  const [db, setDb] = useState<DatabaseFull | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState<string>("");
  const [filters, setFilters] = useState<FilterRule[]>([]);
  const [sorts, setSorts] = useState<SortRule[]>([]);
  const [drawerRowId, setDrawerRowId] = useState<string | null>(null);

  // Mirror latest rows & pending debounce timers so rapid edits never race or drop
  const rowsRef = useRef<DbRow[]>([]);
  const pendingRowTimersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    rowsRef.current = db?.rows ?? [];
  }, [db?.rows]);

  const persistRowInput = useCallback(async (row: DbRow) => {
    const payload: UpsertDbRowInput = {
      id: row.id,
      pageId: row.pageId,
      cells: row.cells,
      linkedPageId: row.linkedPageId,
      sortOrder: row.sortOrder,
    };
    try {
      const saved = await upsertDbRow(payload);
      setDb((prev) => {
        if (!prev || prev.pageId !== saved.pageId) return prev;
        return {
          ...prev,
          rows: prev.rows.map((r) =>
            r.id === saved.id ? { ...r, updatedAt: saved.updatedAt } : r
          ),
        };
      });
    } catch {
      // Keep optimistic state on transient error
    }
  }, []);

  const flushAllPendingRowSaves = useCallback(() => {
    const timers = pendingRowTimersRef.current;
    if (timers.size === 0) return;
    for (const [rowId, timerId] of timers.entries()) {
      window.clearTimeout(timerId);
      const latest = rowsRef.current.find((r) => r.id === rowId);
      if (latest) {
        persistRowInput(latest).catch(() => {});
      }
    }
    timers.clear();
  }, [persistRowInput]);

  useEffect(() => {
    return () => {
      flushAllPendingRowSaves();
    };
  }, [flushAllPendingRowSaves]);

  const loadDatabase = useCallback(async (targetPageId: string) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const loaded = await getDatabase(targetPageId);
      setDb({
        ...loaded,
        columns: getSortedColumns(loaded.columns),
        rows: [...loaded.rows].sort((a, b) => a.sortOrder - b.sortOrder),
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    flushAllPendingRowSaves();
    setSearchQuery("");
    setFilters([]);
    setSorts([]);
    setDrawerRowId(null);
    loadDatabase(pageId).catch(() => {});
  }, [pageId, flushAllPendingRowSaves, loadDatabase]);

  const sortedColumns = useMemo(
    () => getSortedColumns(db?.columns ?? []),
    [db?.columns]
  );

  const visibleRows = useMemo(
    () =>
      applyFiltersAndSorts(
        db?.rows ?? [],
        sortedColumns,
        searchQuery,
        filters,
        sorts
      ),
    [db?.rows, sortedColumns, searchQuery, filters, sorts]
  );

  const handleSwitchView = useCallback(
    async (nextView: ViewMode) => {
      if (!db) return;
      let nextGroupColId = db.groupByColId;
      const current = sortedColumns.find((c) => c.id === nextGroupColId);
      // 看板按状态 / 单选分组；日历和时间线按日期列排
      if (nextView === "board" && !(current && (current.colType === "status" || current.colType === "select"))) {
        const candidate = sortedColumns.find(
          (c) => c.colType === "status" || c.colType === "select"
        );
        nextGroupColId = candidate?.id ?? null;
      }
      if ((nextView === "calendar" || nextView === "timeline") && !(current && current.colType === "date")) {
        nextGroupColId = sortedColumns.find((c) => c.colType === "date")?.id ?? null;
      }

      setDb((prev) =>
        prev
          ? {
              ...prev,
              activeView: nextView,
              groupByColId: nextGroupColId,
            }
          : prev
      );

      try {
        await updateDatabaseView(pageId, nextView, nextGroupColId);
      } catch {
        // Keep optimistic view switch
      }
    },
    [db, pageId, sortedColumns]
  );

  const handleChangeGroupBy = useCallback(
    async (colId: string) => {
      if (!db) return;
      setDb((prev) => (prev ? { ...prev, groupByColId: colId } : prev));
      try {
        await updateDatabaseView(pageId, db.activeView, colId);
      } catch {
        // Keep optimistic groupBy update
      }
    },
    [db, pageId]
  );

  const handleSaveColumn = useCallback(async (input: UpsertDbColumnInput) => {
    if (input.id) {
      // Optimistic column update
      setDb((prev) => {
        if (!prev) return prev;
        const nextCols = prev.columns.map((c) =>
          c.id === input.id
            ? {
                ...c,
                name: input.name,
                colType: input.colType,
                options: input.options,
                width: input.width ?? c.width,
                sortOrder: input.sortOrder ?? c.sortOrder,
              }
            : c
        );
        return { ...prev, columns: getSortedColumns(nextCols) };
      });
    }

    const saved = await upsertDbColumn(input);
    setDb((prev) => {
      if (!prev || prev.pageId !== saved.pageId) return prev;
      const exists = prev.columns.some((c) => c.id === saved.id);
      const nextCols = exists
        ? prev.columns.map((c) => (c.id === saved.id ? saved : c))
        : [...prev.columns, saved];
      return { ...prev, columns: getSortedColumns(nextCols) };
    });
  }, []);

  /** 日历 / 时间线没有日期列时，一键加一个 */
  const handleCreateDateColumn = useCallback(async () => {
    if (!db) return;
    const existingNames = new Set(db.columns.map((c) => c.name));
    let name = "日期";
    let idx = 2;
    while (existingNames.has(name)) name = `日期 ${idx++}`;
    const nextSort = db.columns.reduce((m, c) => Math.max(m, c.sortOrder), 0) + 1;
    const created = await upsertDbColumn({
      pageId,
      name,
      colType: "date",
      options: [],
      width: 140,
      sortOrder: nextSort,
    });
    setDb((prev) =>
      prev && prev.pageId === pageId
        ? { ...prev, groupByColId: created.id, columns: getSortedColumns([...prev.columns, created]) }
        : prev
    );
    await updateDatabaseView(pageId, db.activeView, created.id);
  }, [db, pageId]);

  /** 时间线的结束日期列，按数据库记在本机 */
  const timelineEndKey = `xynote.db.timelineEnd.${pageId}`;
  const [timelineEndColId, setTimelineEndColId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(timelineEndKey);
    } catch {
      return null;
    }
  });
  const changeTimelineEnd = useCallback(
    (colId: string | null) => {
      setTimelineEndColId(colId);
      try {
        if (colId) localStorage.setItem(timelineEndKey, colId);
        else localStorage.removeItem(timelineEndKey);
      } catch {
        /* ignore */
      }
    },
    [timelineEndKey]
  );

  const handleCreateDefaultStatusColumn = useCallback(async () => {
    if (!db) return;
    const statusType: ColumnType = "status";
    const existingNames = new Set(db.columns.map((c) => c.name));
    let name = "状态";
    let idx = 2;
    while (existingNames.has(name)) {
      name = `状态 ${idx++}`;
    }
    const nextSort =
      db.columns.reduce((m, c) => Math.max(m, c.sortOrder), 0) + 1;

    const created = await upsertDbColumn({
      pageId,
      name,
      colType: statusType,
      options: getDefaultOptionsForType(statusType),
      width: 150,
      sortOrder: nextSort,
    });

    setDb((prev) => {
      if (!prev || prev.pageId !== pageId) return prev;
      return {
        ...prev,
        groupByColId: created.id,
        columns: getSortedColumns([...prev.columns, created]),
      };
    });

    await updateDatabaseView(pageId, db.activeView, created.id);
  }, [db, pageId]);

  const handleAddColumnOption = useCallback(
    (col: DbColumn, newOption: SelectOption) => {
      const updatedOptions = [...col.options, newOption];
      handleSaveColumn({
        id: col.id,
        pageId: col.pageId,
        name: col.name,
        colType: col.colType,
        options: updatedOptions,
        width: col.width,
        sortOrder: col.sortOrder,
      }).catch(() => {});
    },
    [handleSaveColumn]
  );

  const handleDeleteColumn = useCallback(async (colId: string) => {
    setFilters((prev) => prev.filter((f) => f.colId !== colId));
    setSorts((prev) => prev.filter((s) => s.colId !== colId));

    setDb((prev) => {
      if (!prev) return prev;
      const remainingCols = prev.columns.filter((c) => c.id !== colId);
      const nextGroupColId =
        prev.groupByColId === colId
          ? remainingCols.find(
              (c) => c.colType === "status" || c.colType === "select"
            )?.id ?? null
          : prev.groupByColId;

      const cleanedRows = prev.rows.map((r) => {
        if (!(colId in r.cells)) return r;
        const copy = { ...r.cells };
        delete copy[colId];
        return { ...r, cells: copy };
      });

      return {
        ...prev,
        groupByColId: nextGroupColId,
        columns: remainingCols,
        rows: cleanedRows,
      };
    });

    await deleteDbColumn(colId);
  }, []);

  const handleUpdateCell = useCallback(
    (rowId: string, colId: string, value: unknown, immediate = false) => {
      let updatedSnapshot: DbRow | null = null;

      setDb((prev) => {
        if (!prev) return prev;
        const nextRows = prev.rows.map((r) => {
          if (r.id !== rowId) return r;
          const nextCells = { ...r.cells, [colId]: value };
          const updated: DbRow = {
            ...r,
            cells: nextCells,
            updatedAt: new Date().toISOString(),
          };
          updatedSnapshot = updated;
          return updated;
        });
        rowsRef.current = nextRows;
        return { ...prev, rows: nextRows };
      });

      const existingTimer = pendingRowTimersRef.current.get(rowId);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
        pendingRowTimersRef.current.delete(rowId);
      }

      if (immediate) {
        const target =
          updatedSnapshot ?? rowsRef.current.find((r) => r.id === rowId);
        if (target) {
          persistRowInput(target).catch(() => {});
        }
      } else {
        const timerId = window.setTimeout(() => {
          pendingRowTimersRef.current.delete(rowId);
          const latest = rowsRef.current.find((r) => r.id === rowId);
          if (latest) {
            persistRowInput(latest).catch(() => {});
          }
        }, 240);
        pendingRowTimersRef.current.set(rowId, timerId);
      }
    },
    [persistRowInput]
  );

  const handleCreateRowWithCells = useCallback(
    async (initialCells: Record<string, unknown> = {}, openDrawer = false) => {
      const currentRows = rowsRef.current;
      const nextOrder =
        currentRows.length > 0
          ? Math.max(...currentRows.map((r) => r.sortOrder)) + 1
          : 0;

      // Seed default first status option if creating a blank row and status col exists without initial value
      const seededCells: Record<string, unknown> = { ...initialCells };
      const statusCol = sortedColumns.find((c) => c.colType === "status");
      if (
        statusCol &&
        statusCol.options.length > 0 &&
        !(statusCol.id in seededCells)
      ) {
        seededCells[statusCol.id] = statusCol.options[0].id;
      }

      const created = await upsertDbRow({
        pageId,
        cells: seededCells,
        linkedPageId: null,
        sortOrder: nextOrder,
      });

      setDb((prev) => {
        if (!prev || prev.pageId !== pageId) return prev;
        const nextRows = [...prev.rows, created];
        rowsRef.current = nextRows;
        return { ...prev, rows: nextRows };
      });

      if (openDrawer) {
        setDrawerRowId(created.id);
      }
    },
    [pageId, sortedColumns]
  );

  const handleDeleteRow = useCallback(async (rowId: string) => {
    const timer = pendingRowTimersRef.current.get(rowId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      pendingRowTimersRef.current.delete(rowId);
    }

    setDrawerRowId((prev) => (prev === rowId ? null : prev));
    setDb((prev) => {
      if (!prev) return prev;
      const nextRows = prev.rows.filter((r) => r.id !== rowId);
      rowsRef.current = nextRows;
      return { ...prev, rows: nextRows };
    });

    await deleteDbRow(rowId);
  }, []);

  const handleOpenOrCreateLinkedPage = useCallback(
    async (row: DbRow) => {
      // Flush any pending typing on this row first
      const pendingTimer = pendingRowTimersRef.current.get(row.id);
      if (pendingTimer !== undefined) {
        window.clearTimeout(pendingTimer);
        pendingRowTimersRef.current.delete(row.id);
      }
      const latestRow =
        rowsRef.current.find((r) => r.id === row.id) ?? row;

      const hasValidExistingLink =
        Boolean(latestRow.linkedPageId) &&
        (pages.length === 0 ||
          pages.some(
            (p) => p.id === latestRow.linkedPageId && !p.isTrashed
          ));

      if (hasValidExistingLink && latestRow.linkedPageId) {
        await persistRowInput(latestRow);
        onOpenPage(latestRow.linkedPageId);
        return;
      }

      if (!onCreateLinkedPage) {
        if (latestRow.linkedPageId) {
          onOpenPage(latestRow.linkedPageId);
        }
        return;
      }

      const titleText =
        getRowTitle(latestRow, sortedColumns).trim() || "未命名记录";
      const newPage = await onCreateLinkedPage(titleText, pageId);

      const savedRow = await upsertDbRow({
        id: latestRow.id,
        pageId: latestRow.pageId,
        cells: latestRow.cells,
        linkedPageId: newPage.id,
        sortOrder: latestRow.sortOrder,
      });

      setDb((prev) => {
        if (!prev || prev.pageId !== pageId) return prev;
        const nextRows = prev.rows.map((r) =>
          r.id === savedRow.id ? savedRow : r
        );
        rowsRef.current = nextRows;
        return { ...prev, rows: nextRows };
      });

      onOpenPage(newPage.id);
    },
    [onCreateLinkedPage, onOpenPage, pageId, pages, persistRowInput, sortedColumns]
  );

  const handleQuickSort = useCallback(
    (colId: string, direction: SortDirection) => {
      setSorts((prev) => {
        const existingIdx = prev.findIndex((s) => s.colId === colId);
        if (existingIdx >= 0) {
          return prev.map((s, idx) =>
            idx === existingIdx ? { ...s, direction } : s
          );
        }
        return [
          ...prev,
          { id: generateLocalId("srt"), colId, direction },
        ];
      });
    },
    []
  );

  const activeDrawerRow = useMemo(
    () => (db?.rows ?? []).find((r) => r.id === drawerRowId) ?? null,
    [db?.rows, drawerRowId]
  );

  if (loading && !db) {
    return (
      <div ref={rootRef} className="nb-db-root nb-db-state-box">
        <Loader2 size={18} className="nb-db-spin" />
        <span>正在加载多维数据库...</span>
      </div>
    );
  }

  if (errorMsg && !db) {
    return (
      <div ref={rootRef} className="nb-db-root nb-db-state-box is-error">
        <AlertCircle size={18} />
        <span>加载数据库失败：{errorMsg}</span>
        <button
          type="button"
          className="nb-db-ghost-btn"
          onClick={() => loadDatabase(pageId)}
        >
          <RefreshCw size={14} />
          <span>重试</span>
        </button>
      </div>
    );
  }

  if (!db) return null;

  return (
    <div ref={rootRef} className="nb-db-root">
      <FilterSortBar
        activeView={db.activeView}
        columns={sortedColumns}
        groupByColId={db.groupByColId}
        searchQuery={searchQuery}
        filters={filters}
        sorts={sorts}
        totalCount={db.rows.length}
        visibleCount={visibleRows.length}
        onSwitchView={handleSwitchView}
        onChangeGroupBy={handleChangeGroupBy}
        onCreateDefaultStatusColumn={handleCreateDefaultStatusColumn}
        onSearchChange={setSearchQuery}
        onFiltersChange={setFilters}
        onSortsChange={setSorts}
        onCreateRow={() => handleCreateRowWithCells({}, false)}
      />

      <div className="nb-db-view-body">
        {db.activeView === "table" && (
          <TableView
            pageId={pageId}
            columns={sortedColumns}
            rows={visibleRows}
            allRows={db.rows}
            onUpdateCell={handleUpdateCell}
            onAddColumnOption={handleAddColumnOption}
            onSaveColumn={handleSaveColumn}
            onDeleteColumn={handleDeleteColumn}
            onCreateRow={() => handleCreateRowWithCells({}, false)}
            onDeleteRow={handleDeleteRow}
            onOpenOrCreateLinkedPage={handleOpenOrCreateLinkedPage}
            onOpenRowDrawer={setDrawerRowId}
            onQuickSort={handleQuickSort}
          />
        )}

        {db.activeView === "board" && (
          <BoardView
            columns={sortedColumns}
            rows={visibleRows}
            allRows={db.rows}
            groupByColId={db.groupByColId}
            onUpdateCell={handleUpdateCell}
            onAddColumnOption={handleAddColumnOption}
            onCreateDefaultStatusColumn={handleCreateDefaultStatusColumn}
            onCreateRowWithCells={handleCreateRowWithCells}
            onDeleteRow={handleDeleteRow}
            onOpenOrCreateLinkedPage={handleOpenOrCreateLinkedPage}
            onOpenRowDrawer={setDrawerRowId}
          />
        )}

        {db.activeView === "calendar" && (
          <CalendarView
            columns={sortedColumns}
            rows={visibleRows}
            dateColId={db.groupByColId}
            onChangeDateCol={handleChangeGroupBy}
            onCreateDateColumn={() => {
              handleCreateDateColumn().catch(() => {});
            }}
            onUpdateCell={handleUpdateCell}
            onCreateRowWithCells={handleCreateRowWithCells}
            onOpenRowDrawer={setDrawerRowId}
          />
        )}

        {db.activeView === "timeline" && (
          <TimelineView
            columns={sortedColumns}
            rows={visibleRows}
            startColId={db.groupByColId}
            endColId={timelineEndColId}
            onChangeStartCol={handleChangeGroupBy}
            onChangeEndCol={changeTimelineEnd}
            onCreateDateColumn={() => {
              handleCreateDateColumn().catch(() => {});
            }}
            onOpenRowDrawer={setDrawerRowId}
          />
        )}

        {db.activeView === "gallery" && (
          <GalleryView
            columns={sortedColumns}
            rows={visibleRows}
            pages={pages}
            onUpdateCell={handleUpdateCell}
            onCreateCard={() => handleCreateRowWithCells({}, true)}
            onDeleteRow={handleDeleteRow}
            onOpenOrCreateLinkedPage={handleOpenOrCreateLinkedPage}
            onOpenRowDrawer={setDrawerRowId}
          />
        )}
      </div>

      <RowDetailDrawer
        row={activeDrawerRow}
        columns={sortedColumns}
        allRows={db.rows}
        pages={pages}
        hostEl={rootRef.current}
        onClose={() => setDrawerRowId(null)}
        onUpdateCell={handleUpdateCell}
        onAddColumnOption={handleAddColumnOption}
        onDeleteRow={handleDeleteRow}
        onOpenOrCreateLinkedPage={handleOpenOrCreateLinkedPage}
      />
    </div>
  );
};
