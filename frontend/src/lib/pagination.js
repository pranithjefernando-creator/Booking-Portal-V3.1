import { useMemo, useState } from "react";

export function paginate(items, page = 1, pageSize = 25) {
  const size = Number.isFinite(Number(pageSize)) ? Math.max(1, Math.floor(Number(pageSize))) : 25;
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const currentPage = Number.isFinite(Number(page)) ? Math.min(pageCount, Math.max(1, Math.floor(Number(page)))) : 1;
  const offset = (currentPage - 1) * size;
  return { items: items.slice(offset, offset + size), page: currentPage, pageSize: size, pageCount, total, start: total ? offset + 1 : 0, end: Math.min(offset + size, total) };
}

export function usePagination(items, resetKey = items) {
  const [state, setState] = useState({ resetKey, page: 1, pageSize: 25 });
  if (state.resetKey !== resetKey) setState({ resetKey, page: 1, pageSize: state.pageSize });
  const result = useMemo(() => paginate(items || [], state.resetKey === resetKey ? state.page : 1, state.pageSize), [items, state.resetKey, resetKey, state.page, state.pageSize]);
  return {
    ...result,
    setPage: (page) => setState({ resetKey, page, pageSize: result.pageSize }),
    setPageSize: (pageSize) => setState({ resetKey, page: 1, pageSize }),
  };
}