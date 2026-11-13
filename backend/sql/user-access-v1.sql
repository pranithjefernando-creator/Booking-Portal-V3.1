-- Initialized explicitly; not yet used by the application.
CREATE SCHEMA IF NOT EXISTS portal_access_v1;

CREATE TABLE IF NOT EXISTS portal_access_v1.roles (
  name text PRIMARY KEY CHECK (name = btrim(name) AND length(name) > 0),
  description text NOT NULL DEFAULT '',
  builtin boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS portal_access_v1.permissions (
  code text PRIMARY KEY CHECK (code = btrim(code) AND length(code) > 0),
  label text NOT NULL CHECK (length(btrim(label)) > 0)
);

CREATE TABLE IF NOT EXISTS portal_access_v1.modules (
  code text PRIMARY KEY CHECK (code = btrim(code) AND length(code) > 0),
  label text NOT NULL CHECK (length(btrim(label)) > 0)
);

CREATE TABLE IF NOT EXISTS portal_access_v1.users (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  email text NOT NULL CHECK (
    email = btrim(email) AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  role_name text NOT NULL REFERENCES portal_access_v1.roles(name),
  branch_code text NOT NULL DEFAULT 'CMB',
  modules_configured boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON portal_access_v1.users (lower(email));
CREATE INDEX IF NOT EXISTS users_role_name_idx ON portal_access_v1.users (role_name);

CREATE TABLE IF NOT EXISTS portal_access_v1.user_credentials (
  user_id uuid PRIMARY KEY REFERENCES portal_access_v1.users(id) ON DELETE CASCADE,
  password_salt bytea NOT NULL CHECK (octet_length(password_salt) = 16),
  password_hash bytea NOT NULL CHECK (octet_length(password_hash) = 64),
  session_version uuid NOT NULL,
  must_change boolean NOT NULL,
  failed_attempts integer NOT NULL CHECK (failed_attempts >= 0 AND failed_attempts < 5),
  locked_until bigint NOT NULL CHECK (locked_until >= 0)
);

CREATE TABLE IF NOT EXISTS portal_access_v1.role_permissions (
  role_name text NOT NULL REFERENCES portal_access_v1.roles(name) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES portal_access_v1.permissions(code),
  PRIMARY KEY (role_name, permission_code)
);

CREATE TABLE IF NOT EXISTS portal_access_v1.role_modules (
  role_name text NOT NULL REFERENCES portal_access_v1.roles(name) ON DELETE CASCADE,
  module_code text NOT NULL REFERENCES portal_access_v1.modules(code),
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (role_name, module_code),
  UNIQUE (role_name, position)
);

CREATE TABLE IF NOT EXISTS portal_access_v1.user_modules (
  user_id uuid NOT NULL REFERENCES portal_access_v1.users(id) ON DELETE CASCADE,
  module_code text NOT NULL REFERENCES portal_access_v1.modules(code),
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (user_id, module_code),
  UNIQUE (user_id, position)
);

CREATE TABLE IF NOT EXISTS portal_access_v1.user_organization_scopes (
  user_id uuid NOT NULL REFERENCES portal_access_v1.users(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN (
    'booking', 'booking_shipper', 'booking_consignee',
    'order', 'order_supplier', 'order_buyer', 'tracking'
  )),
  organization_code text NOT NULL CHECK (organization_code = btrim(organization_code) AND length(organization_code) > 0),
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (user_id, scope_type, organization_code),
  UNIQUE (user_id, scope_type, position)
);

CREATE TABLE IF NOT EXISTS portal_access_v1.approval_rule_configurations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  enabled boolean NOT NULL,
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portal_access_v1.visibility_profiles (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  module text NOT NULL CHECK (module IN ('booking', 'order')),
  hidden_fields jsonb NOT NULL CHECK (jsonb_typeof(hidden_fields) = 'array'),
  UNIQUE (id, module)
);

CREATE TABLE IF NOT EXISTS portal_access_v1.user_rule_assignments (
  user_id uuid PRIMARY KEY REFERENCES portal_access_v1.users(id) ON DELETE CASCADE,
  configuration_id uuid NOT NULL REFERENCES portal_access_v1.approval_rule_configurations(id)
);

CREATE TABLE IF NOT EXISTS portal_access_v1.user_visibility_assignments (
  user_id uuid NOT NULL REFERENCES portal_access_v1.users(id) ON DELETE CASCADE,
  module text NOT NULL,
  profile_id uuid NOT NULL,
  PRIMARY KEY (user_id, module),
  FOREIGN KEY (profile_id, module) REFERENCES portal_access_v1.visibility_profiles(id, module)
);
