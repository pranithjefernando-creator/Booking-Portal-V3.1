class ConnectionPool {
  async connect() { return this; }
  request() {
    return {
      async query(sql) {
        if (sql.includes("ORDER BY")) return { recordset: [] };
        return { recordset: [{ OrderNumber: process.env.TEST_ORDER_NO, SupplierCode: "TESTCO", OrderStatusDescription: "PENDING" }] };
      }
    };
  }
  async close() {}
}

export default { ConnectionPool };
