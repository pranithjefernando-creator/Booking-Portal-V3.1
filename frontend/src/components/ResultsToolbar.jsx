import React from "react";

function ToolbarIcon({ name }) {
  const paths = {
    layout: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 9h18M9 9v12" /></>,
    columns: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></>,
    save: <><path d="M5 3h12l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M7 3v6h9V3M7 21v-8h10v8" /></>,
    download: <><path d="M12 3v12m-4-4 4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>,
    chevron: <path d="m6 9 6 6 6-6" />
  };
  return <svg className="results-toolbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export default function ResultsToolbar({ layouts, onApplyLayout, columnsOpen, onToggleColumns, onSaveLayout, onExport }) {
  return (
    <div className="results-toolbar">
      <div className="results-layout-select">
        <ToolbarIcon name="layout" />
        <select
          aria-label="Apply a saved column layout"
          defaultValue=""
          onChange={(event) => { onApplyLayout(event.target.value); event.target.value = ""; }}
        >
          <option value="">Column layouts</option>
          {layouts.map((layout) => <option key={layout.id} value={layout.id}>{layout.name}</option>)}
        </select>
        <ToolbarIcon name="chevron" />
      </div>
      <div className="results-toolbar-actions">
        <button type="button" className="results-action" aria-expanded={columnsOpen} onClick={onToggleColumns}><ToolbarIcon name="columns" />Columns</button>
        <button type="button" className="results-action" onClick={onSaveLayout}><ToolbarIcon name="save" />Save layout</button>
        <button type="button" className="results-action results-action-export" onClick={onExport}><ToolbarIcon name="download" />Export to Excel</button>
      </div>
    </div>
  );
}
