CREATE SCHEMA IF NOT EXISTS booking_portal_v3;

CREATE SEQUENCE IF NOT EXISTS booking_portal_v3.booking_reference_seq START WITH 24861;

CREATE TABLE IF NOT EXISTS booking_portal_v3.bookings (
  id text PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);

CREATE TABLE IF NOT EXISTS booking_portal_v3.approvals (
  id text PRIMARY KEY,
  booking_id text NOT NULL REFERENCES booking_portal_v3.bookings(id),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);

CREATE INDEX IF NOT EXISTS approvals_booking_id_idx
  ON booking_portal_v3.approvals (booking_id);

CREATE TABLE IF NOT EXISTS booking_portal_v3.templates (
  id text PRIMARY KEY,
  owner_email text NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);

CREATE INDEX IF NOT EXISTS templates_owner_email_idx
  ON booking_portal_v3.templates (owner_email);

CREATE TABLE IF NOT EXISTS booking_portal_v3.imports (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);

CREATE TABLE IF NOT EXISTS booking_portal_v3.preferences (
  owner_email text NOT NULL,
  preference_type text NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'array'),
  PRIMARY KEY (owner_email, preference_type)
);

CREATE TABLE IF NOT EXISTS booking_portal_v3.order_links (
  order_id text PRIMARY KEY,
  booking_id text NOT NULL REFERENCES booking_portal_v3.bookings(id)
);

CREATE INDEX IF NOT EXISTS order_links_booking_id_idx
  ON booking_portal_v3.order_links (booking_id);
