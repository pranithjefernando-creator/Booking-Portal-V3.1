import React from "react";

export default function SortableHeader({ label, column, sort, onSort, draggable = false, onDragStart, onDragOver, onDrop }) {
  const active = sort.key === column;
  const ariaSort = active ? (sort.direction === "asc" ? "ascending" : "descending") : "none";
  return (
    <th
      aria-sort={ariaSort}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={draggable ? "draggable-col" : undefined}
      title={draggable ? "Drag to reorder; click to sort" : "Click to sort"}
    >
      {draggable && <span aria-hidden="true">⠿ </span>}
      <button type="button" className="table-sort-button" onClick={() => onSort(column)}>
        {label}{active ? (sort.direction === "asc" ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );
}
