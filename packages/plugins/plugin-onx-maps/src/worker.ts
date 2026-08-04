import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
  type ToolResult,
} from "@paperclipai/plugin-sdk";

import { ACTION_KEYS, DATA_KEYS, ROUTE_KEYS, TOOL_NAMES } from "./constants.js";
import { OnxExportError } from "./export.js";
import * as service from "./service.js";
import { OnxServiceError } from "./service.js";
import * as store from "./store.js";

let activeContext: PluginContext | null = null;

function requireContext(): PluginContext {
  if (!activeContext) {
    throw new Error("onX Maps plugin worker is not initialised");
  }
  return activeContext;
}

// ---------------------------------------------------------------------------
// Param coercion
//
// Bridge and tool params arrive as unvalidated JSON. These helpers keep the
// handlers below free of repeated shape checks.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function num(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === "string");
  return items.length > 0 ? items : undefined;
}

function requireCompanyId(value: unknown): string {
  const companyId = text(value);
  if (!companyId) {
    throw new OnxServiceError("companyId is required");
  }
  return companyId;
}

/** Map internal errors onto messages that are useful to an agent or operator. */
function toToolError(error: unknown): ToolResult {
  if (error instanceof OnxServiceError || error instanceof OnxExportError) {
    return { error: error.message };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

function registerTools(ctx: PluginContext): void {
  ctx.tools.register(
    TOOL_NAMES.search,
    {
      displayName: "Search onX Markups",
      description:
        "Search imported onX markups by name, description, or folder. Returns coordinates and measurements.",
      parametersSchema: { type: "object", properties: {} },
    },
    async (params, runCtx) => {
      try {
        const input = asRecord(params);
        const markups = await service.searchMarkups(ctx, {
          companyId: runCtx.companyId,
          query: text(input.query),
          kind: service.parseKind(input.kind),
          folderPath: text(input.folderPath),
          limit: num(input.limit),
        });

        if (markups.length === 0) {
          return {
            content:
              "No onX markups matched. Use onx_list_folders to see which folders exist, or import an onX GPX/KML export first.",
            data: { markups: [], count: 0 },
          };
        }

        return {
          content: markups.map((markup) => service.describeMarkup(markup)).join("\n"),
          data: {
            count: markups.length,
            markups: markups.map((markup) => service.toAgentSummary(markup)),
          },
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  ctx.tools.register(
    TOOL_NAMES.near,
    {
      displayName: "Find onX Markups Near a Point",
      description: "List imported onX markups within a radius of a lat/lon, nearest first.",
      parametersSchema: { type: "object", properties: {} },
    },
    async (params, runCtx) => {
      try {
        const input = asRecord(params);
        const lat = num(input.lat);
        const lon = num(input.lon);
        if (lat === undefined || lon === undefined) {
          return { error: "lat and lon are required numbers." };
        }

        const results = await service.markupsNear(ctx, {
          companyId: runCtx.companyId,
          lat,
          lon,
          radiusMiles: num(input.radiusMiles),
          kind: service.parseKind(input.kind),
          limit: num(input.limit),
        });

        if (results.length === 0) {
          return {
            content: `No onX markups within that radius of ${lat}, ${lon}.`,
            data: { markups: [], count: 0 },
          };
        }

        return {
          content: results
            .map(
              (entry) =>
                `${(entry.distanceMeters / 1609.344).toFixed(2)} mi — ${service.describeMarkup(entry.markup)}`,
            )
            .join("\n"),
          data: {
            count: results.length,
            markups: results.map((entry) => ({
              ...service.toAgentSummary(entry.markup),
              distanceMiles: Math.round((entry.distanceMeters / 1609.344) * 100) / 100,
            })),
          },
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  ctx.tools.register(
    TOOL_NAMES.get,
    {
      displayName: "Get onX Markup",
      description: "Read one onX markup in full, including linked issues.",
      parametersSchema: { type: "object", properties: {} },
    },
    async (params, runCtx) => {
      try {
        const input = asRecord(params);
        const markupId = text(input.markupId);
        if (!markupId) return { error: "markupId is required." };

        const markup = await store.getMarkupById(ctx.db, runCtx.companyId, markupId);
        if (!markup) return { error: `No onX markup ${markupId} in this company.` };

        const issueIds = await store.listMarkupIssueIds(ctx.db, runCtx.companyId, markupId);
        const summary = service.toAgentSummary(markup, {
          includeGeometry: input.includeGeometry === true,
        });

        return {
          content: service.describeMarkup(markup),
          data: { ...summary, linkedIssueIds: issueIds },
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  ctx.tools.register(
    TOOL_NAMES.folders,
    {
      displayName: "List onX Folders",
      description: "List onX folders present in imported markups with a count for each.",
      parametersSchema: { type: "object", properties: {} },
    },
    async (_params, runCtx) => {
      try {
        const folders = await store.listFolders(ctx.db, runCtx.companyId);
        if (folders.length === 0) {
          return { content: "No onX markups have been imported yet.", data: { folders: [] } };
        }
        return {
          content: folders
            .map(
              (folder) =>
                `${folder.folderPath ?? "(no folder)"} — ${folder.markupCount} markup(s)`,
            )
            .join("\n"),
          data: { folders },
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  ctx.tools.register(
    TOOL_NAMES.exportMarkups,
    {
      displayName: "Export onX Markups",
      description: "Build a GPX or KML file from a selection of markups for re-import into onX.",
      parametersSchema: { type: "object", properties: {} },
    },
    async (params, runCtx) => {
      try {
        const input = asRecord(params);
        const format = text(input.format);
        if (format !== "gpx" && format !== "kml") {
          return { error: 'format must be "gpx" or "kml".' };
        }

        const result = await service.buildExport(ctx, {
          companyId: runCtx.companyId,
          format,
          markupIds: stringList(input.markupIds),
          kind: service.parseKind(input.kind),
          folderPath: text(input.folderPath),
          search: text(input.search),
        });

        const notes = result.warnings.length > 0 ? `\n\nNote: ${result.warnings.join(" ")}` : "";
        return {
          content: `Built ${result.filename} with ${result.markupCount} markup(s), ${result.byteSize} bytes.${notes}`,
          data: {
            filename: result.filename,
            format: result.format,
            markupCount: result.markupCount,
            byteSize: result.byteSize,
            warnings: result.warnings,
            content: result.content,
          },
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// UI bridge
// ---------------------------------------------------------------------------

function registerBridge(ctx: PluginContext): void {
  ctx.data.register(DATA_KEYS.overview, async (params) => {
    const companyId = requireCompanyId(params.companyId);
    const [overview, config, folders] = await Promise.all([
      store.getOverview(ctx.db, companyId),
      service.readConfig(ctx, companyId),
      store.listFolders(ctx.db, companyId),
    ]);
    return { ...overview, folders, config };
  });

  ctx.data.register(DATA_KEYS.markups, async (params) => {
    const companyId = requireCompanyId(params.companyId);
    const markups = await store.listMarkups(ctx.db, companyId, {
      kinds: service.parseKind(params.kind) ? [service.parseKind(params.kind)!] : undefined,
      folderPath: text(params.folderPath) ?? undefined,
      search: text(params.search),
      importId: text(params.importId),
      limit: num(params.limit) ?? 2000,
    });
    return { markups, count: markups.length };
  });

  ctx.data.register(DATA_KEYS.markup, async (params) => {
    const companyId = requireCompanyId(params.companyId);
    const markupId = text(params.markupId);
    if (!markupId) throw new OnxServiceError("markupId is required");
    const markup = await store.getMarkupById(ctx.db, companyId, markupId);
    if (!markup) return { markup: null, linkedIssueIds: [] };
    return {
      markup,
      linkedIssueIds: await store.listMarkupIssueIds(ctx.db, companyId, markupId),
    };
  });

  ctx.data.register(DATA_KEYS.imports, async (params) => {
    const companyId = requireCompanyId(params.companyId);
    return { imports: await store.listImports(ctx.db, companyId) };
  });

  ctx.data.register("issue-links", async (params) => {
    const companyId = requireCompanyId(params.companyId);
    const issueId = text(params.issueId);
    if (!issueId) throw new OnxServiceError("issueId is required");
    return { links: await store.listIssueLinks(ctx.db, companyId, issueId) };
  });

  ctx.actions.register(ACTION_KEYS.import, async (params, context) => {
    const companyId = requireCompanyId(params.companyId ?? context.companyId);
    const content = typeof params.content === "string" ? params.content : "";
    return service.importExport(ctx, {
      companyId,
      filename: text(params.filename) ?? "onx-export",
      content,
      importedBy: context.actor.userId ?? context.actor.agentId,
    });
  });

  ctx.actions.register(ACTION_KEYS.deleteImport, async (params, context) => {
    const companyId = requireCompanyId(params.companyId ?? context.companyId);
    const importId = text(params.importId);
    if (!importId) throw new OnxServiceError("importId is required");
    return service.deleteImport(ctx, companyId, importId);
  });

  ctx.actions.register(ACTION_KEYS.exportMarkups, async (params, context) => {
    const companyId = requireCompanyId(params.companyId ?? context.companyId);
    const format = text(params.format);
    if (format !== "gpx" && format !== "kml") {
      throw new OnxServiceError('format must be "gpx" or "kml"');
    }
    return service.buildExport(ctx, {
      companyId,
      format,
      markupIds: stringList(params.markupIds),
      kind: service.parseKind(params.kind),
      folderPath: text(params.folderPath),
      search: text(params.search),
    });
  });

  ctx.actions.register("link-markup", async (params, context) => {
    const companyId = requireCompanyId(params.companyId ?? context.companyId);
    const issueId = text(params.issueId);
    const markupId = text(params.markupId);
    if (!issueId || !markupId) {
      throw new OnxServiceError("issueId and markupId are required");
    }
    const result = await store.linkMarkupToIssue(
      ctx.db,
      companyId,
      issueId,
      markupId,
      text(params.note),
      context.actor.userId ?? context.actor.agentId,
    );
    if (result.linked) {
      await ctx.activity.log({
        companyId,
        message: "Attached an onX markup to an issue",
        entityType: "issue",
        entityId: issueId,
        metadata: { markupId },
      });
    }
    return result;
  });

  ctx.actions.register("unlink-markup", async (params, context) => {
    const companyId = requireCompanyId(params.companyId ?? context.companyId);
    const issueId = text(params.issueId);
    const markupId = text(params.markupId);
    if (!issueId || !markupId) {
      throw new OnxServiceError("issueId and markupId are required");
    }
    const result = await store.unlinkMarkupFromIssue(ctx.db, companyId, issueId, markupId);
    if (result.unlinked) {
      await ctx.activity.log({
        companyId,
        message: "Removed an onX markup from an issue",
        entityType: "issue",
        entityId: issueId,
        metadata: { markupId },
      });
    }
    return result;
  });
}

// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    activeContext = ctx;
    registerTools(ctx);
    registerBridge(ctx);
    ctx.logger.info("onX Maps plugin ready", { namespace: ctx.db.namespace });
  },

  async onHealth() {
    if (!activeContext) {
      return { status: "error", message: "Worker not initialised" };
    }
    return {
      status: "ok",
      message: "onX Maps worker running",
      details: { namespace: activeContext.db.namespace },
    };
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const warnings: string[] = [];

    const tileUrl = config.basemapTileUrl;
    if (typeof tileUrl === "string" && tileUrl.trim().length > 0) {
      if (!/^https:\/\//i.test(tileUrl)) {
        errors.push("Basemap tile URL must be an https:// URL.");
      }
      for (const token of ["{z}", "{x}", "{y}"]) {
        if (!tileUrl.includes(token)) {
          errors.push(`Basemap tile URL must contain the ${token} placeholder.`);
        }
      }
      if (typeof config.basemapAttribution !== "string" || config.basemapAttribution.trim() === "") {
        warnings.push(
          "No basemap attribution set. Most tile providers, including OpenStreetMap, require visible attribution.",
        );
      }
    }

    const threshold = config.elevationGainThresholdMeters;
    if (threshold !== undefined && (typeof threshold !== "number" || threshold < 0)) {
      errors.push("Elevation noise threshold must be a non-negative number.");
    }

    return { ok: errors.length === 0, errors, warnings };
  },

  async onApiRequest(input: PluginApiRequestInput) {
    const ctx = requireContext();

    try {
      switch (input.routeKey) {
        case ROUTE_KEYS.imports:
          return { body: { imports: await store.listImports(ctx.db, input.companyId) } };

        case ROUTE_KEYS.createImport: {
          const body = asRecord(input.body);
          const content = typeof body.content === "string" ? body.content : "";
          const summary = await service.importExport(ctx, {
            companyId: input.companyId,
            filename: text(body.filename) ?? "onx-export",
            content,
            importedBy: input.actor.userId ?? input.actor.agentId ?? null,
          });
          return { status: summary.alreadyImported ? 200 : 201, body: summary };
        }

        case ROUTE_KEYS.markups: {
          const markups = await store.listMarkups(ctx.db, input.companyId, {
            kinds: service.parseKind(input.query.kind)
              ? [service.parseKind(input.query.kind)!]
              : undefined,
            folderPath: text(input.query.folderPath) ?? undefined,
            search: text(input.query.search),
            limit: num(input.query.limit),
          });
          return { body: { markups, count: markups.length } };
        }

        case ROUTE_KEYS.markup: {
          const markup = await store.getMarkupById(
            ctx.db,
            input.companyId,
            input.params.markupId ?? "",
          );
          if (!markup) return { status: 404, body: { error: "Markup not found" } };
          return {
            body: {
              markup,
              linkedIssueIds: await store.listMarkupIssueIds(ctx.db, input.companyId, markup.id),
            },
          };
        }

        case ROUTE_KEYS.exportMarkups: {
          const body = asRecord(input.body);
          const format = text(body.format);
          if (format !== "gpx" && format !== "kml") {
            return { status: 400, body: { error: 'format must be "gpx" or "kml"' } };
          }
          const result = await service.buildExport(ctx, {
            companyId: input.companyId,
            format,
            markupIds: stringList(body.markupIds),
            kind: service.parseKind(body.kind),
            folderPath: text(body.folderPath),
            search: text(body.search),
          });
          return { body: result };
        }

        default:
          return { status: 404, body: { error: `Unknown route ${input.routeKey}` } };
      }
    } catch (error) {
      if (error instanceof OnxServiceError || error instanceof OnxExportError) {
        return { status: 400, body: { error: error.message } };
      }
      throw error;
    }
  },

  async onShutdown() {
    activeContext = null;
  },
});

export default plugin;

// Starts the stdio RPC host when this module is the child process entrypoint.
// Without it the worker loads, resolves, and exits cleanly — which the host
// reports as "Worker process exited (code=0)".
runWorker(plugin, import.meta.url);
