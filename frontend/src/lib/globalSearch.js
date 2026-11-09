function searchPath(path, term) {
  return `${path}?q=${encodeURIComponent(term)}`;
}

export function globalSearchPath(term, { bookingItems = [], orderItems = [], canViewOrders = false } = {}) {
  const query = term.trim();
  const ordersPath = searchPath("/orders", query);
  const bookingsPath = searchPath("/bookings", query);
  if (!query) return null;

  if (canViewOrders && (/^(ord|po)[-\s]/i.test(query) || /order/i.test(query))) return ordersPath;
  if (/^(bk|booking)[-\s]/i.test(query)) return bookingsPath;
  if (canViewOrders && orderItems.length > 0 && bookingItems.length === 0) return ordersPath;
  return bookingsPath;
}
