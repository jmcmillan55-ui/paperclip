export const PLUGIN_ID = "paperclipai.plugin-onx-maps";
export const PLUGIN_VERSION = "0.1.0";

/**
 * Host-derived schema name for this plugin's database namespace.
 *
 * The host computes `plugin_${namespaceSlug}_${sha256(pluginKey).slice(0, 10)}`
 * (see `derivePluginDatabaseNamespace` in the server). Migration SQL cannot
 * interpolate, so the literal is duplicated here and asserted in tests.
 */
export const DB_NAMESPACE = "plugin_onx_maps_a339fb09d4";
export const DB_NAMESPACE_SLUG = "onx_maps";

export const PAGE_ROUTE = "onx-maps";

export const SLOT_IDS = {
  page: "onx-maps-page",
  sidebar: "onx-maps-sidebar",
  settingsPage: "onx-maps-settings",
  issueTab: "onx-maps-issue-tab",
} as const;

export const EXPORT_NAMES = {
  page: "OnxMapsPage",
  sidebar: "OnxMapsSidebarLink",
  settingsPage: "OnxMapsSettingsPage",
  issueTab: "OnxMapsIssueTab",
} as const;

export const TOOL_NAMES = {
  search: "onx_search_markups",
  near: "onx_markups_near",
  get: "onx_get_markup",
  folders: "onx_list_folders",
  exportMarkups: "onx_export_markups",
} as const;

export const DATA_KEYS = {
  overview: "overview",
  markups: "markups",
  markup: "markup",
  imports: "imports",
} as const;

export const ACTION_KEYS = {
  import: "import-file",
  deleteImport: "delete-import",
  exportMarkups: "export-markups",
} as const;

export const ROUTE_KEYS = {
  imports: "imports",
  createImport: "create-import",
  markups: "markups",
  markup: "markup",
  exportMarkups: "export-markups",
} as const;

export const OBJECT_REFERENCE_PROVIDER_KEY = "onx";

/**
 * onX enforces these on import; we enforce the same ceilings on export so a
 * generated file is always loadable back into the onX Web Map.
 *
 * @see https://support.onxmaps.com/hc/en-us/articles/115002196452
 */
export const ONX_MAX_IMPORT_BYTES = 4 * 1024 * 1024;
export const ONX_MAX_MARKUPS_PER_FILE = 3000;

/**
 * The host caps scoped plugin API route bodies at 1 MB and returns 413 before
 * the worker is ever invoked, so `POST /api/plugins/:id/api/imports` cannot
 * carry a full-size onX export. The UI upload path goes through the action
 * bridge instead, which sits under the server's 10 MB JSON limit and handles
 * the whole 4 MB range.
 */
export const SCOPED_API_ROUTE_BODY_LIMIT_BYTES = 1_000_000;

export const DEFAULT_CONFIG = {
  basemapTileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  basemapAttribution: "© OpenStreetMap contributors",
  elevationGainThresholdMeters: 3,
} as const;
