import React, { useEffect, useState } from "react";
import { api } from "../api.js";

const OPERATORS = [
  { value: "contains", label: "contains" },
  { value: "eq", label: "equals" },
  { value: "neq", label: "does not equal" },
  { value: "gt", label: "is greater than" },
  { value: "gte", label: "is at least" },
  { value: "lt", label: "is less than" },
  { value: "lte", label: "is at most" }
];
const ORDERED_OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte"];

function emptyFilter(fields) {
  const field = fields[0];
  return { field: field?.key || "", operator: field?.type === "number" || field?.type === "date" || field?.type === "boolean" ? "eq" : "contains", value: "" };
}

export default function SearchFilterBuilder({ fields, endpoint, onApply, onError }) {
  const [filters, setFilters] = useState([]);
  const [layouts, setLayouts] = useState([]);
  const [layoutName, setLayoutName] = useState("");
  const [selectedLayout, setSelectedLayout] = useState("");

  const loadLayouts = () => api.get(`${endpoint}/filters/list`).then((data) => setLayouts(data.layouts || [])).catch((error) => onError(error.message));
  useEffect(() => { loadLayouts(); }, [endpoint]); // eslint-disable-line

  function updateFilter(index, patch) {
    setFilters((current) => current.map((filter, itemIndex) => {
      if (itemIndex !== index) return filter;
      const updated = { ...filter, ...patch };
      if (patch.field) {
        const field = fields.find((item) => item.key === patch.field);
        updated.type = field?.type || "text";
        updated.operator = field?.type === "number" || field?.type === "date" || field?.type === "boolean" ? "eq" : "contains";
        updated.value = "";
      }
      return updated;
    }));
  }

  function activeFilters() {
    return filters.filter((filter) => filter.field && filter.operator && filter.value !== "" && filter.value != null)
      .map((filter) => ({ field: filter.field, operator: filter.operator, value: filter.value, type: fields.find((field) => field.key === filter.field)?.type || "text" }));
  }

  function apply() {
    onApply(activeFilters());
  }

  function clear() {
    setFilters([]);
    setSelectedLayout("");
    onApply([]);
  }

  function selectLayout(id) {
    setSelectedLayout(id);
    if (!id) return;
    const layout = layouts.find((item) => item.id === id);
    if (!layout) return;
    const loaded = (layout.filters || []).map((filter) => ({ ...filter }));
    setFilters(loaded);
    onApply(loaded);
  }

  async function saveLayout() {
    const current = activeFilters();
    if (!layoutName.trim() || !current.length) return;
    try {
      const data = await api.post(`${endpoint}/filters`, { name: layoutName.trim(), filters: current });
      setLayouts(data.layouts || []);
      const saved = (data.layouts || []).find((item) => item.name.toLowerCase() === layoutName.trim().toLowerCase());
      setSelectedLayout(saved?.id || "");
      setLayoutName("");
    } catch (error) {
      onError(error.message);
    }
  }

  async function deleteLayout() {
    if (!selectedLayout) return;
    try {
      const data = await api.del(`${endpoint}/filters/${selectedLayout}`);
      setLayouts(data.layouts || []);
      setSelectedLayout("");
    } catch (error) {
      onError(error.message);
    }
  }

  return (
    <div className="search-filter-builder">
      <div className="filter-layout-row">
        <select value={selectedLayout} onChange={(event) => selectLayout(event.target.value)} aria-label="Saved filter layouts">
          <option value="">Saved filter layouts…</option>
          {layouts.map((layout) => <option key={layout.id} value={layout.id}>{layout.name}</option>)}
        </select>
        <button className="btn btn-ghost btn-sm" disabled={!selectedLayout} onClick={deleteLayout}>Delete layout</button>
      </div>
      {filters.map((filter, index) => {
        const field = fields.find((item) => item.key === filter.field) || fields[0];
        const operators = field?.type === "number" || field?.type === "date"
          ? OPERATORS.filter((item) => ORDERED_OPERATORS.includes(item.value))
          : field?.type === "boolean"
            ? OPERATORS.filter((item) => ["eq", "neq"].includes(item.value))
          : OPERATORS.filter((item) => ["contains", "eq", "neq"].includes(item.value));
        return (
          <div className="search-filter-row" key={index}>
            <select value={filter.field} onChange={(event) => updateFilter(index, { field: event.target.value })} aria-label={`Filter ${index + 1} field`}>
              {fields.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
            <select value={filter.operator} onChange={(event) => updateFilter(index, { operator: event.target.value })} aria-label={`Filter ${index + 1} operator`}>
              {operators.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            {field?.type === "boolean"
              ? <select value={filter.value} onChange={(event) => updateFilter(index, { value: event.target.value })} aria-label={`Filter ${index + 1} value`}><option value="">Select…</option><option value="true">Yes</option><option value="false">No</option></select>
              : <input type={field?.type === "number" || field?.type === "date" ? field.type : "text"} step={field?.type === "number" ? "any" : undefined} value={filter.value} onChange={(event) => updateFilter(index, { value: event.target.value })} aria-label={`Filter ${index + 1} value`} placeholder="Value" />}
            <button className="btn-x" onClick={() => setFilters((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove filter ${index + 1}`}>×</button>
          </div>
        );
      })}
      <div className="search-filter-actions">
        <button className="btn btn-ghost btn-sm" onClick={() => setFilters((current) => [...current, emptyFilter(fields)])}>+ Add filter</button>
        <button className="btn btn-outline btn-sm" onClick={apply}>Apply filters</button>
        <button className="btn btn-ghost btn-sm" onClick={clear}>Clear filters</button>
      </div>
      <div className="filter-layout-row">
        <input value={layoutName} onChange={(event) => setLayoutName(event.target.value)} placeholder="Name this filter layout" aria-label="Filter layout name" />
        <button className="btn btn-outline btn-sm" disabled={!layoutName.trim() || !activeFilters().length} onClick={saveLayout}>Save filter layout</button>
      </div>
    </div>
  );
}
