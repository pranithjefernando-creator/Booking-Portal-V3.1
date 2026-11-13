import React from "react";
import { Navigate, NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { PageBanner } from "../components/ui.jsx";

const sections = [
  { path: "users", label: "User management", permission: "admin.users" },
  { path: "approval-visibility", label: "Approval and visibility configurations", permission: "admin.users" },
  { path: "roles", label: "Role and access settings", permission: "admin.roles" },
  { path: "user-scope", label: "User modules and scope", permission: "admin.users" },
  { path: "operations", label: "Operation reconciliation", permission: "admin.users" }
];

export function AdminIndex() {
  const { me } = useAuth();
  const firstSection = sections.find((section) => me.permissions.includes(section.permission));
  return firstSection
    ? <Navigate to={`/admin/${firstSection.path}`} replace />
    : <p role="alert">You do not have access to admin settings.</p>;
}

export function AdminSection({ permission, children }) {
  const { me } = useAuth();
  const firstSection = sections.find((section) => me.permissions.includes(section.permission));
  if (!me.permissions.includes(permission)) {
    return firstSection
      ? <Navigate to={`/admin/${firstSection.path}`} replace />
      : <p role="alert">You do not have access to admin settings.</p>;
  }
  return children;
}

export default function AdminShell() {
  const { me } = useAuth();
  const availableSections = sections.filter((section) => me.permissions.includes(section.permission));
  return <div className="page">
    <PageBanner title="Settings" subtitle="Manage users, approvals, roles and access." />
    <nav className="admin-subnav" aria-label="Admin settings">
      {availableSections.map((section) => <NavLink key={section.path} to={`/admin/${section.path}`} className={({ isActive }) => `admin-subnav-link${isActive ? " active" : ""}`}>
        {section.label}
      </NavLink>)}
    </nav>
    <Outlet />
  </div>;
}
