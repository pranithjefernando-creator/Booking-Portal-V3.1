import React from "react";
import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import { useAuth } from "./context/AuthContext.jsx";
import { Spinner } from "./components/ui.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import CreateBooking from "./pages/CreateBooking.jsx";
import ImportBookings from "./pages/ImportBookings.jsx";
import Approvals from "./pages/Approvals.jsx";
import Bookings from "./pages/Bookings.jsx";
import Tracking from "./pages/Tracking.jsx";
import ShipmentTracking from "./pages/ShipmentTracking.jsx";
import ShipmentSearch from "./pages/ShipmentSearch.jsx";
import BookingDetail from "./pages/BookingDetail.jsx";
import Orders from "./pages/Orders.jsx";
import CreateOrder from "./pages/CreateOrder.jsx";
import AuditLog from "./pages/AuditLog.jsx";
import Login from "./pages/Login.jsx";
import ChangePassword from "./pages/ChangePassword.jsx";
import TransitionUsers from "./pages/TransitionUsers.jsx";
import TransitionAccess from "./pages/TransitionAccess.jsx";
import TransitionConfigurations from "./pages/TransitionConfigurations.jsx";
import AdminShell, { AdminIndex, AdminSection } from "./pages/AdminShell.jsx";
export default function App() {
  const { loading, token, me, accessError, refresh, logout } = useAuth();
  if (!token) return <Login />;
  if (!loading && accessError) return <div className="login-page"><div className="card login-card">
    <p role="alert">{accessError}</p>
    <button type="button" className="btn btn-primary" onClick={refresh}>Try again</button>
    <button type="button" className="btn" onClick={logout}>Sign out</button>
  </div></div>;
  if (loading || !me) return <div className="boot"><Spinner label="Starting SBMS…" /></div>;
  if (me.mustChangePassword) return <ChangePassword forced onDone={refresh} />;
  const accessKey = JSON.stringify([me.user?.id, me.user?.role, me.user?.trackingOrgs, me.modules]);
  return (<Layout key={accessKey}><Routes>
    <Route path="/" element={<Dashboard />} /><Route path="/create" element={<CreateBooking />} /><Route path="/bookings/:id/edit" element={<CreateBooking />} /><Route path="/bookings/:id" element={<BookingDetail />} /><Route path="/bookings" element={<Bookings />} /><Route path="/tracking" element={<Tracking />} /><Route path="/tracking/shipments" element={<ShipmentSearch />} /><Route path="/tracking/shipment/:id" element={<ShipmentTracking />} /><Route path="/import" element={<ImportBookings />} /><Route path="/approvals" element={<Approvals />} /><Route path="/orders/new" element={<CreateOrder />} /><Route path="/orders/:id" element={<CreateOrder />} /><Route path="/orders" element={<Orders />} /><Route path="/audit" element={<AuditLog />} />
    <Route path="/admin" element={<AdminShell />}>
      <Route index element={<AdminIndex />} />
      <Route path="users" element={<AdminSection permission="admin.users"><TransitionUsers /></AdminSection>} />
      <Route path="approval-visibility" element={<AdminSection permission="admin.users"><TransitionConfigurations /></AdminSection>} />
      <Route path="roles" element={<AdminSection permission="admin.roles"><TransitionAccess section="roles" /></AdminSection>} />
      <Route path="user-scope" element={<AdminSection permission="admin.users"><TransitionAccess section="scope" /></AdminSection>} />
    </Route>
    <Route path="/account" element={<ChangePassword />} /><Route path="*" element={<div className="card">Page not found.</div>} />
  </Routes></Layout>);
}
