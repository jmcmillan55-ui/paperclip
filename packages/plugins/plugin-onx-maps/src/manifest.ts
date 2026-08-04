import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

import {
  DB_NAMESPACE_SLUG,
  DEFAULT_CONFIG,
  EXPORT_NAMES,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  ROUTE_KEYS,
  SLOT_IDS,
  TOOL_NAMES,
} from "./constants.js";
import { MARKUP_KINDS } from "./model.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "onX Maps",
  description:
    "Import onX Maps GPX/KML exports as company-scoped markups, browse them on a map, attach them to issues, query them from agent tools, and export selections back out for re-import into onX.",
  author: "Paperclip",
  categories: ["connector", "ui"],
  capabilities: [
    "companies.read",
    "issues.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "api.routes.register",
    "agent.tools.register",
    "activity.log.write",
    "instance.settings.register",
    "ui.page.register",
    "ui.sidebar.register",
    "ui.detailTab.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    namespaceSlug: DB_NAMESPACE_SLUG,
    migrationsDir: "migrations",
    coreReadTables: ["companies", "issues"],
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      basemapTileUrl: {
        type: "string",
        title: "Basemap tile URL",
        description:
          "XYZ raster tile template used behind markups. onX's own tiles are licensed for use inside onX apps only and cannot be used here; the default is OpenStreetMap. Leave blank to draw markups on a plain background with no basemap.",
        default: DEFAULT_CONFIG.basemapTileUrl,
      },
      basemapAttribution: {
        type: "string",
        title: "Basemap attribution",
        description:
          "Attribution text shown over the map. Required by most tile providers, including OpenStreetMap.",
        default: DEFAULT_CONFIG.basemapAttribution,
      },
      elevationGainThresholdMeters: {
        type: "number",
        title: "Elevation noise threshold (metres)",
        description:
          "Elevation changes smaller than this are treated as GPS jitter and excluded from track gain/loss totals.",
        default: DEFAULT_CONFIG.elevationGainThresholdMeters,
      },
    },
  },
  tools: [
    {
      name: TOOL_NAMES.search,
      displayName: "Search onX Markups",
      description:
        "Search imported onX markups (waypoints, tracks, routes, lines, area shapes) by name, description, or folder. Returns coordinates and measurements for each match.",
      parametersSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text matched against markup name, description, and folder path.",
          },
          kind: {
            type: "string",
            enum: [...MARKUP_KINDS],
            description: "Restrict results to one markup type.",
          },
          folderPath: {
            type: "string",
            description: "Restrict results to one onX folder, e.g. \"Elk 2025 / North Ridge\".",
          },
          limit: { type: "number", description: "Maximum results (default 25, max 200)." },
        },
      },
    },
    {
      name: TOOL_NAMES.near,
      displayName: "Find onX Markups Near a Point",
      description:
        "List imported onX markups within a radius of a latitude/longitude, nearest first, with the distance to each.",
      parametersSchema: {
        type: "object",
        properties: {
          lat: { type: "number", description: "Latitude in decimal degrees." },
          lon: { type: "number", description: "Longitude in decimal degrees." },
          radiusMiles: { type: "number", description: "Search radius in miles (default 5)." },
          kind: { type: "string", enum: [...MARKUP_KINDS] },
          limit: { type: "number", description: "Maximum results (default 25, max 200)." },
        },
        required: ["lat", "lon"],
      },
    },
    {
      name: TOOL_NAMES.get,
      displayName: "Get onX Markup",
      description:
        "Read one onX markup in full, including its geometry, measurements, source folder, and any issues it is attached to.",
      parametersSchema: {
        type: "object",
        properties: {
          markupId: { type: "string", description: "Markup UUID." },
          includeGeometry: {
            type: "boolean",
            description:
              "Include the full coordinate list. Off by default because tracks can hold thousands of points.",
          },
        },
        required: ["markupId"],
      },
    },
    {
      name: TOOL_NAMES.folders,
      displayName: "List onX Folders",
      description:
        "List the onX folders present in imported markups, with a markup count for each. Use this to discover valid folderPath values before searching.",
      parametersSchema: { type: "object", properties: {} },
    },
    {
      name: TOOL_NAMES.exportMarkups,
      displayName: "Export onX Markups",
      description:
        "Build a GPX or KML file from a selection of markups, ready to import back into the onX Web Map. Returns the file content plus any conversion warnings onX will apply.",
      parametersSchema: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["gpx", "kml"], description: "Output format." },
          markupIds: {
            type: "array",
            items: { type: "string" },
            description: "Specific markups to export. Omit to export everything matching the filters.",
          },
          kind: { type: "string", enum: [...MARKUP_KINDS] },
          folderPath: { type: "string" },
          search: { type: "string" },
        },
        required: ["format"],
      },
    },
  ],
  apiRoutes: [
    {
      routeKey: ROUTE_KEYS.imports,
      method: "GET",
      path: "/imports",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: ROUTE_KEYS.createImport,
      method: "POST",
      path: "/imports",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: ROUTE_KEYS.markups,
      method: "GET",
      path: "/markups",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: ROUTE_KEYS.markup,
      method: "GET",
      path: "/markups/:markupId",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: ROUTE_KEYS.exportMarkups,
      method: "POST",
      path: "/export",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "onX Maps",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.sidebar,
        displayName: "onX Maps",
        exportName: EXPORT_NAMES.sidebar,
      },
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "onX Maps Settings",
        exportName: EXPORT_NAMES.settingsPage,
      },
      {
        type: "detailTab",
        id: SLOT_IDS.issueTab,
        displayName: "onX Markups",
        exportName: EXPORT_NAMES.issueTab,
        entityTypes: ["issue"],
      },
    ],
  },
};

export default manifest;
