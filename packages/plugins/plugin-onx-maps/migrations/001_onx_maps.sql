-- onX Maps plugin — imports and normalized markups.
--
-- The schema name is host-derived as
-- `plugin_${namespaceSlug}_${sha256(pluginKey).slice(0, 10)}` and cannot be
-- interpolated here, so it is written out literally. `DB_NAMESPACE` in
-- src/constants.ts mirrors it and tests assert the two agree.

CREATE TABLE plugin_onx_maps_a339fb09d4.onx_imports (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  filename text NOT NULL,
  format text NOT NULL,
  content_hash text NOT NULL,
  byte_size integer NOT NULL,
  markup_count integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  imported_by text,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX onx_imports_company_idx
  ON plugin_onx_maps_a339fb09d4.onx_imports (company_id, imported_at DESC);

-- Re-uploading the identical export is a no-op rather than a duplicate row.
CREATE UNIQUE INDEX onx_imports_company_hash_idx
  ON plugin_onx_maps_a339fb09d4.onx_imports (company_id, content_hash);

CREATE TABLE plugin_onx_maps_a339fb09d4.onx_markups (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  import_id uuid NOT NULL REFERENCES plugin_onx_maps_a339fb09d4.onx_imports(id) ON DELETE CASCADE,
  external_key text NOT NULL,
  kind text NOT NULL,
  name text,
  description text,
  folder_path text,
  symbol text,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  elevation_meters double precision,
  source_time text,
  geometry jsonb NOT NULL,
  min_lon double precision NOT NULL,
  min_lat double precision NOT NULL,
  max_lon double precision NOT NULL,
  max_lat double precision NOT NULL,
  point_count integer NOT NULL DEFAULT 0,
  distance_meters double precision,
  elevation_gain_meters double precision,
  elevation_loss_meters double precision,
  min_elevation_meters double precision,
  max_elevation_meters double precision,
  area_square_meters double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The dedupe boundary: the same real-world markup re-exported from onX lands
-- on the same external_key and is skipped instead of duplicated.
CREATE UNIQUE INDEX onx_markups_company_external_key_idx
  ON plugin_onx_maps_a339fb09d4.onx_markups (company_id, external_key);

CREATE INDEX onx_markups_company_kind_idx
  ON plugin_onx_maps_a339fb09d4.onx_markups (company_id, kind);

CREATE INDEX onx_markups_company_folder_idx
  ON plugin_onx_maps_a339fb09d4.onx_markups (company_id, folder_path);

CREATE INDEX onx_markups_import_idx
  ON plugin_onx_maps_a339fb09d4.onx_markups (import_id);

-- Proximity search reads a lat/lon window before ranking by true distance,
-- so a plain composite index on the representative point carries it.
CREATE INDEX onx_markups_company_point_idx
  ON plugin_onx_maps_a339fb09d4.onx_markups (company_id, lat, lon);

-- Markups attached to an issue.
--
-- This lives in a plugin-owned table rather than in `plugin_entities` because
-- attaching is only half the feature: `ctx.entities` can upsert and list but
-- has no delete, so detaching would be impossible.
CREATE TABLE plugin_onx_maps_a339fb09d4.onx_issue_links (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES public.issues(id) ON DELETE CASCADE,
  markup_id uuid NOT NULL REFERENCES plugin_onx_maps_a339fb09d4.onx_markups(id) ON DELETE CASCADE,
  note text,
  linked_by text,
  linked_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX onx_issue_links_issue_markup_idx
  ON plugin_onx_maps_a339fb09d4.onx_issue_links (issue_id, markup_id);

CREATE INDEX onx_issue_links_company_issue_idx
  ON plugin_onx_maps_a339fb09d4.onx_issue_links (company_id, issue_id);

CREATE INDEX onx_issue_links_markup_idx
  ON plugin_onx_maps_a339fb09d4.onx_issue_links (markup_id);
