-- Provider cache schema initialized at backend startup.
CREATE SCHEMA IF NOT EXISTS booking_portal_v4;

CREATE TABLE IF NOT EXISTS booking_portal_v4.provider_tracking_cache (
  provider_account text NOT NULL CHECK (length(btrim(provider_account)) > 0 AND provider_account = btrim(provider_account)),
  provider_environment text NOT NULL CHECK (length(btrim(provider_environment)) > 0 AND provider_environment = btrim(provider_environment)),
  request_key text NOT NULL CHECK (length(btrim(request_key)) > 0),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  error jsonb CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > fetched_at),
  PRIMARY KEY (provider_account, provider_environment, request_key),
  CHECK ((result IS NULL) <> (error IS NULL))
);
CREATE INDEX IF NOT EXISTS provider_tracking_cache_expiry_idx
  ON booking_portal_v4.provider_tracking_cache (expires_at);

CREATE TABLE IF NOT EXISTS booking_portal_v4.provider_port_cache (
  provider_account text NOT NULL CHECK (length(btrim(provider_account)) > 0 AND provider_account = btrim(provider_account)),
  provider_environment text NOT NULL CHECK (length(btrim(provider_environment)) > 0 AND provider_environment = btrim(provider_environment)),
  port_code text NOT NULL CHECK (port_code ~ '^[A-Z]{2}[A-Z0-9]{3}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  source text NOT NULL CHECK (length(btrim(source)) > 0),
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > fetched_at),
  PRIMARY KEY (provider_account, provider_environment, port_code)
);
CREATE INDEX IF NOT EXISTS provider_port_cache_expiry_idx
  ON booking_portal_v4.provider_port_cache (expires_at);

CREATE TABLE IF NOT EXISTS booking_portal_v4.provider_usage (
  provider_account text NOT NULL CHECK (length(btrim(provider_account)) > 0 AND provider_account = btrim(provider_account)),
  provider_environment text NOT NULL CHECK (length(btrim(provider_environment)) > 0 AND provider_environment = btrim(provider_environment)),
  month_start date NOT NULL CHECK (extract(day FROM month_start) = 1),
  monthly_count bigint NOT NULL DEFAULT 0 CHECK (monthly_count >= 0),
  blocked_until timestamptz,
  PRIMARY KEY (provider_account, provider_environment)
);

CREATE TABLE IF NOT EXISTS booking_portal_v4.provider_request_events (
  provider_account text NOT NULL,
  provider_environment text NOT NULL,
  request_id text NOT NULL CHECK (length(btrim(request_id)) > 0),
  requested_at timestamptz NOT NULL,
  PRIMARY KEY (provider_account, provider_environment, request_id),
  FOREIGN KEY (provider_account, provider_environment)
    REFERENCES booking_portal_v4.provider_usage (provider_account, provider_environment) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS provider_request_events_window_idx
  ON booking_portal_v4.provider_request_events (provider_account, provider_environment, requested_at);
CREATE INDEX IF NOT EXISTS provider_request_events_expiry_idx
  ON booking_portal_v4.provider_request_events (requested_at);

CREATE TABLE IF NOT EXISTS booking_portal_v4.provider_fetch_leases (
  provider_account text NOT NULL CHECK (length(btrim(provider_account)) > 0 AND provider_account = btrim(provider_account)),
  provider_environment text NOT NULL CHECK (length(btrim(provider_environment)) > 0 AND provider_environment = btrim(provider_environment)),
  cache_kind text NOT NULL CHECK (cache_kind IN ('tracking', 'port')),
  cache_key text NOT NULL CHECK (length(btrim(cache_key)) > 0),
  lease_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('active', 'uncertain')),
  started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > started_at),
  PRIMARY KEY (provider_account, provider_environment, cache_kind, cache_key)
);
CREATE INDEX IF NOT EXISTS provider_fetch_leases_expiry_idx
  ON booking_portal_v4.provider_fetch_leases (expires_at);

CREATE TABLE IF NOT EXISTS booking_portal_v4.provider_port_retries (
  provider_account text NOT NULL CHECK (length(btrim(provider_account)) > 0 AND provider_account = btrim(provider_account)),
  provider_environment text NOT NULL CHECK (length(btrim(provider_environment)) > 0 AND provider_environment = btrim(provider_environment)),
  port_code text NOT NULL CHECK (port_code ~ '^[A-Z]{2}[A-Z0-9]{3}$'),
  retry_id uuid NOT NULL UNIQUE,
  cache_fetched_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  PRIMARY KEY (provider_account, provider_environment, port_code)
);
CREATE INDEX IF NOT EXISTS provider_port_retries_due_idx
  ON booking_portal_v4.provider_port_retries (provider_account, provider_environment, due_at);
