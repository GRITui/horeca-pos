import type { ReactNode } from "react";
import { cx } from "./cx";

type ColumnBase = {
  /** Stable column id, used as the React key for header/cells. */
  key: string;
  header: ReactNode;
  align?: "left" | "center" | "right";
  /** Extra classes for every `<td>` in this column. */
  className?: string;
  /** Extra classes for this column's `<th>`. */
  headerClassName?: string;
};

/**
 * A column either names a property of the row (rendered with `String(...)`)
 * or provides an explicit `render` function — enforced at the type level.
 */
export type TableColumn<T> =
  | (ColumnBase & { key: keyof T & string; render?: (row: T, index: number) => ReactNode })
  | (ColumnBase & { render: (row: T, index: number) => ReactNode });

export interface TableProps<T> {
  columns: ReadonlyArray<TableColumn<T>>;
  rows: ReadonlyArray<T>;
  /** Stable key per row; defaults to the row index. */
  rowKey?: (row: T, index: number) => string | number;
  /** Rendered inside the table body when `rows` is empty. */
  empty?: ReactNode;
  /** Applied to the scroll wrapper around the `<table>`. */
  className?: string;
}

const ALIGN_CLASSES = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
} as const;

function cellContent<T>(column: TableColumn<T>, row: T, index: number): ReactNode {
  if (column.render) return column.render(row, index);
  const value = (row as Record<string, unknown>)[column.key];
  return value == null ? "—" : String(value);
}

/**
 * Data table with typed generic column definitions. Server-component safe —
 * pass `render` functions only from other server components or mark the
 * consuming component `"use client"`.
 */
export function Table<T>({ columns, rows, rowKey, empty, className }: TableProps<T>) {
  return (
    <div className={cx("overflow-x-auto", className)}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cx(
                  "px-4 py-3 font-medium",
                  ALIGN_CLASSES[column.align ?? "left"],
                  column.headerClassName,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && empty != null ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400"
              >
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr
                key={rowKey ? rowKey(row, index) : index}
                className="border-b border-zinc-100 last:border-0 dark:border-zinc-800"
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cx(
                      "px-4 py-3 text-zinc-700 dark:text-zinc-300",
                      ALIGN_CLASSES[column.align ?? "left"],
                      column.className,
                    )}
                  >
                    {cellContent(column, row, index)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
