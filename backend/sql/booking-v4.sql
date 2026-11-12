-- Relational booking schema initialized at startup.
CREATE SCHEMA IF NOT EXISTS booking_portal_v4;

CREATE SEQUENCE IF NOT EXISTS booking_portal_v4.booking_reference_seq START WITH 24861;

CREATE TABLE IF NOT EXISTS booking_portal_v4.bookings (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  reference text NOT NULL UNIQUE CHECK (length(btrim(reference)) > 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'VALIDATED', 'PENDING_APPROVAL', 'APPROVED', 'COMPLETED', 'CANCELLED')),
  mode text,
  incoterm_code text,
  freight_terms text,
  origin_code text,
  dest_code text,
  cargo_ready_date date,
  commodity_code text,
  goods_description text,
  marks_and_numbers text,
  shipper_reference_no text,
  notes text,
  branch_code text,
  cw_org_code text,
  shipper_code text,
  consignee_code text,
  cfs_received boolean,
  cfs_received_at date,
  is_dg boolean,
  dg_un_number text,
  dg_proper_shipping_name text,
  dg_class text,
  dg_packing_group text,
  dg_special_handling text,
  pickup_required boolean,
  pickup_phone text,
  pickup_contact text,
  pickup_address text,
  pickup_estimated_pickup date,
  pickup_required_date date,
  pickup_estimated_delivery date,
  pickup_delivery_required_by date,
  required_pickup date,
  required_etd date,
  required_eta date,
  requested_delivery date,
  client_requested_eta date,
  handling_remarks text,
  documents_accompanying text,
  cw1_shipment_ref text,
  cw_status text,
  cw_http_status integer,
  cw_response text,
  cw_sent_at timestamptz,
  cw_converted boolean,
  cw_last_action text,
  created_by_user_id text,
  created_by_email text,
  created_by text,
  updated_by text,
  created_at timestamptz,
  updated_at timestamptz,
  completed_at timestamptz,
  additional_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(additional_data) = 'object')
);

CREATE INDEX IF NOT EXISTS bookings_status_idx ON booking_portal_v4.bookings (status);
CREATE INDEX IF NOT EXISTS bookings_cw_org_code_idx ON booking_portal_v4.bookings (cw_org_code);
CREATE INDEX IF NOT EXISTS bookings_created_at_idx ON booking_portal_v4.bookings (created_at);

CREATE TABLE IF NOT EXISTS booking_portal_v4.booking_parties (
  booking_id text NOT NULL REFERENCES booking_portal_v4.bookings(id) ON DELETE CASCADE,
  party_type text NOT NULL CHECK (party_type IN ('shipper', 'consignee')),
  code text,
  company_name text,
  name text,
  address1 text,
  address2 text,
  city text,
  state text,
  post_code text,
  country text,
  phone text,
  email text,
  additional_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(additional_data) = 'object'),
  PRIMARY KEY (booking_id, party_type)
);

CREATE TABLE IF NOT EXISTS booking_portal_v4.booking_cargo_lines (
  booking_id text NOT NULL REFERENCES booking_portal_v4.bookings(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  id text NOT NULL CHECK (length(btrim(id)) > 0),
  packages numeric,
  package_type_code text,
  gross_weight numeric,
  weight_unit text,
  volume numeric,
  volume_unit text,
  hs_code text,
  po_numbers text,
  order_id text,
  commodity_code text,
  un_number text,
  dg_class text,
  additional_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(additional_data) = 'object'),
  PRIMARY KEY (booking_id, position),
  UNIQUE (booking_id, id)
);

CREATE TABLE IF NOT EXISTS booking_portal_v4.booking_containers (
  booking_id text NOT NULL REFERENCES booking_portal_v4.bookings(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  id text NOT NULL CHECK (length(btrim(id)) > 0),
  container_type_code text,
  count numeric,
  additional_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(additional_data) = 'object'),
  PRIMARY KEY (booking_id, position),
  UNIQUE (booking_id, id)
);

CREATE TABLE IF NOT EXISTS booking_portal_v4.booking_documents (
  booking_id text NOT NULL REFERENCES booking_portal_v4.bookings(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  id text NOT NULL CHECK (length(btrim(id)) > 0),
  type text NOT NULL,
  type_name text,
  file_name text NOT NULL,
  size bigint NOT NULL CHECK (size >= 0),
  mime_type text,
  content bytea NOT NULL,
  uploaded_by text,
  additional_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(additional_data) = 'object'),
  PRIMARY KEY (booking_id, position),
  UNIQUE (booking_id, id),
  CHECK (size = octet_length(content))
);

CREATE TABLE IF NOT EXISTS booking_portal_v4.approvals (
  id text PRIMARY KEY,
  booking_id text NOT NULL REFERENCES booking_portal_v4.bookings(id),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX IF NOT EXISTS approvals_booking_id_idx ON booking_portal_v4.approvals (booking_id);

CREATE TABLE IF NOT EXISTS booking_portal_v4.templates (
  id text PRIMARY KEY,
  owner_email text NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX IF NOT EXISTS templates_owner_email_idx ON booking_portal_v4.templates (owner_email);

CREATE TABLE IF NOT EXISTS booking_portal_v4.imports (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);

CREATE TABLE IF NOT EXISTS booking_portal_v4.preferences (
  owner_email text NOT NULL,
  preference_type text NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'array'),
  PRIMARY KEY (owner_email, preference_type)
);

CREATE TABLE IF NOT EXISTS booking_portal_v4.order_links (
  order_id text PRIMARY KEY,
  booking_id text NOT NULL REFERENCES booking_portal_v4.bookings(id)
);
CREATE INDEX IF NOT EXISTS order_links_booking_id_idx ON booking_portal_v4.order_links (booking_id);
