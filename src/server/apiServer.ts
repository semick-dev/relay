import * as http from "http";

import { RelayAdoClient, RelayAuthError } from "./adoClient";
import { RelayCacheStore } from "./cacheStore";
import { RelayStorage } from "./storage";
import { RelayTelemetrySink } from "./telemetry";
import {
  BuildResponse,
  BuildsResponse,
  DefinitionsPrecacheStatusResponse,
  DefinitionsResponse,
  ErrorResponse,
  ProjectsResponse,
  RefreshRequest,
  RelayBuildDetails,
  RelayBuildSummary,
  RelayDefinitionSummary,
  RelayProject,
  SessionResponse,
  TelemetryPayload
} from "../shared/types";

const TTL_SECONDS = {
  projects: 3600,
  builds: 60,
  build: 300,
  definitions: 900
} as const;

interface DefinitionsJob {
  running: boolean;
  loadedCount: number;
  totalCount: number;
  lastRefresh?: string;
  error?: string;
}

export class RelayApiServer {
  private server: http.Server;
  private port = 0;
  private readonly definitionJobs = new Map<string, DefinitionsJob>();

  constructor(
    private readonly adoClient: RelayAdoClient,
    private readonly cacheStore: RelayCacheStore,
    private readonly storage: RelayStorage,
    private readonly telemetry: RelayTelemetrySink
  ) {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async start(): Promise<number> {
    await this.storage.ensureReady();
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Relay server failed to bind."));
          return;
        }
        this.port = address.port;
        resolve();
      });
    });
    await this.telemetry.log("relay.server.started", "info", { port: this.port });
    return this.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  getBaseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const span = await this.telemetry.span("relay.http.request", {
      method: req.method,
      url: req.url
    });

    try {
      const requestUrl = new URL(req.url ?? "/", this.getBaseUrl());
      const method = req.method ?? "GET";

      if (method === "OPTIONS") {
        this.sendJson(res, 204, { ok: true });
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/session") {
        const payload: SessionResponse = this.buildSessionResponse();
        this.sendJson(res, 200, payload);
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/org/projects") {
        const orgUrl = requestUrl.searchParams.get("orgUrl") ?? "";
        const refresh = requestUrl.searchParams.get("refresh") === "1";
        const payload = await this.loadProjects(orgUrl, refresh);
        this.sendJson(res, 200, payload);
        return;
      }

      if (method === "GET" && requestUrl.pathname.startsWith("/api/projects/") && requestUrl.pathname.endsWith("/builds")) {
        const project = decodeURIComponent(requestUrl.pathname.split("/")[3] ?? "");
        const orgUrl = requestUrl.searchParams.get("orgUrl") ?? "";
        const refresh = requestUrl.searchParams.get("refresh") === "1";
        const definitionId = Number(requestUrl.searchParams.get("definitionId") ?? "0");
        const payload = await this.loadBuilds(orgUrl, project, refresh, Number.isFinite(definitionId) && definitionId > 0 ? definitionId : undefined);
        this.sendJson(res, 200, payload);
        return;
      }

      if (method === "GET" && requestUrl.pathname.startsWith("/api/projects/") && requestUrl.pathname.endsWith("/definitions")) {
        const project = decodeURIComponent(requestUrl.pathname.split("/")[3] ?? "");
        const orgUrl = requestUrl.searchParams.get("orgUrl") ?? "";
        const refresh = requestUrl.searchParams.get("refresh") === "1";
        const payload = await this.loadDefinitions(orgUrl, project, refresh);
        this.sendJson(res, 200, payload);
        return;
      }

      if (method === "GET" && requestUrl.pathname.startsWith("/api/projects/") && requestUrl.pathname.endsWith("/definitions/status")) {
        const project = decodeURIComponent(requestUrl.pathname.split("/")[3] ?? "");
        const orgUrl = requestUrl.searchParams.get("orgUrl") ?? "";
        const payload = await this.getDefinitionsStatus(orgUrl, project);
        this.sendJson(res, 200, payload);
        return;
      }

      if (method === "POST" && requestUrl.pathname.startsWith("/api/projects/") && requestUrl.pathname.endsWith("/definitions/precache")) {
        const project = decodeURIComponent(requestUrl.pathname.split("/")[3] ?? "");
        const body = await readJsonBody<{ orgUrl?: string; limitedRefresh?: boolean }>(req);
        const payload = await this.startDefinitionsPrecache(body.orgUrl ?? "", project, body.limitedRefresh !== false);
        this.sendJson(res, 202, payload);
        return;
      }

      if (method === "GET" && requestUrl.pathname.startsWith("/api/builds/")) {
        const buildId = Number(requestUrl.pathname.split("/")[3] ?? "0");
        const orgUrl = requestUrl.searchParams.get("orgUrl") ?? "";
        const project = requestUrl.searchParams.get("project") ?? "";
        const refresh = requestUrl.searchParams.get("refresh") === "1";
        const payload = await this.loadBuild(orgUrl, project, buildId, refresh);
        this.sendJson(res, 200, payload);
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/cache/refresh") {
        const body = await readJsonBody<RefreshRequest>(req);
        const payload = await this.refresh(body);
        this.sendJson(res, 200, payload);
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/telemetry") {
        const body = await readJsonBody<TelemetryPayload>(req);
        await this.telemetry.ingest(body);
        this.sendJson(res, 202, { ok: true });
        return;
      }

      this.sendJson(res, 404, {
        ok: false,
        code: "not_found",
        error: `No route for ${method} ${requestUrl.pathname}`
      } satisfies ErrorResponse);
    } catch (error) {
      await this.telemetry.log("relay.http.error", "error", {
        message: error instanceof Error ? error.message : String(error)
      }, span);
      this.sendJson(res, error instanceof RelayAuthError ? 401 : 500, normalizeError(error));
    }
  }

  private buildSessionResponse(): SessionResponse {
    const authConfigured = Boolean(process.env.ADO_TOKEN);
    return {
      ok: authConfigured,
      authConfigured,
      message: authConfigured
        ? "Relay is ready."
        : "ADO_TOKEN is not set. Restart VS Code with ADO_TOKEN in the environment."
    };
  }

  private async loadProjects(orgUrl: string, forceRefresh: boolean): Promise<ProjectsResponse> {
    validateOrgUrl(orgUrl);
    const adoUrl = new URL("_apis/projects", orgUrl);
    adoUrl.searchParams.set("api-version", "7.1-preview.4");

    return await this.withCache<RelayProject[], ProjectsResponse>({
      cacheUrl: adoUrl.toString(),
      ttlSeconds: TTL_SECONDS.projects,
      forceRefresh,
      fetcher: () => this.adoClient.listProjects(orgUrl),
      mapper: (projects, cached, lastRefresh) => ({
        ok: true,
        projects,
        cached,
        lastRefresh
      }),
      eventName: "relay.projects.load"
    });
  }

  private async loadBuilds(orgUrl: string, project: string, forceRefresh: boolean, definitionId?: number): Promise<BuildsResponse> {
    validateOrgUrl(orgUrl);
    if (!project) {
      throw new Error("Project is required.");
    }

    const adoUrl = new URL(`${encodeURIComponent(project)}/_apis/build/builds`, orgUrl);
    adoUrl.searchParams.set("$top", "10");
    adoUrl.searchParams.set("queryOrder", "queueTimeDescending");
    adoUrl.searchParams.set("api-version", "7.1-preview.7");
    if (definitionId) {
      adoUrl.searchParams.set("definitions", String(definitionId));
    }

    return await this.withCache<RelayBuildSummary[], BuildsResponse>({
      cacheUrl: adoUrl.toString(),
      ttlSeconds: TTL_SECONDS.builds,
      forceRefresh,
      fetcher: () => this.adoClient.listBuilds(orgUrl, project, 10, definitionId),
      mapper: (builds, cached, lastRefresh) => ({
        ok: true,
        projectName: project,
        builds,
        cached,
        lastRefresh
      }),
      eventName: "relay.builds.load"
    });
  }

  private async loadBuild(orgUrl: string, project: string, buildId: number, forceRefresh: boolean): Promise<BuildResponse> {
    validateOrgUrl(orgUrl);
    if (!project || !Number.isFinite(buildId) || buildId <= 0) {
      throw new Error("Project and buildId are required.");
    }

    const adoUrl = new URL(`${encodeURIComponent(project)}/_apis/build/builds/${buildId}`, orgUrl);
    adoUrl.searchParams.set("api-version", "7.1-preview.7");

    const response = await this.withCache<RelayBuildDetails, BuildResponse>({
      cacheUrl: adoUrl.toString(),
      ttlSeconds: TTL_SECONDS.build,
      forceRefresh,
      fetcher: async () => {
        const fresh = await this.adoClient.getBuild(orgUrl, project, buildId);
        await this.storage.writeBuildTimestamp(buildId, new Date().toISOString());
        return fresh;
      },
      mapper: (build, cached, lastRefresh) => ({
        ok: true,
        build: {
          ...build,
          cached,
          lastRefresh
        }
      }),
      eventName: "relay.build.load"
    });

    await this.storage.writeBuildTimestamp(buildId, response.build.lastRefresh);
    return response;
  }

  private async loadDefinitions(orgUrl: string, project: string, forceRefresh: boolean): Promise<DefinitionsResponse> {
    validateOrgUrl(orgUrl);
    if (!project) {
      throw new Error("Project is required.");
    }

    const adoUrl = new URL(`${encodeURIComponent(project)}/_apis/build/definitions`, orgUrl);
    adoUrl.searchParams.set("api-version", "7.1");
    adoUrl.searchParams.set("includeLatestBuilds", "true");

    return await this.withCache<RelayDefinitionSummary[], DefinitionsResponse>({
      cacheUrl: adoUrl.toString(),
      ttlSeconds: TTL_SECONDS.definitions,
      forceRefresh,
      fetcher: async () => await this.adoClient.listDefinitions(orgUrl, project),
      mapper: (definitions, cached, lastRefresh) => ({
        ok: true,
        projectName: project,
        definitions,
        cached,
        lastRefresh
      }),
      eventName: "relay.definitions.load"
    });
  }

  private async getDefinitionsStatus(orgUrl: string, project: string): Promise<DefinitionsPrecacheStatusResponse> {
    validateOrgUrl(orgUrl);
    if (!project) {
      throw new Error("Project is required.");
    }

    const jobKey = this.getDefinitionsJobKey(orgUrl, project);
    const job = this.definitionJobs.get(jobKey);
    return {
      ok: true,
      projectName: project,
      running: job?.running ?? false,
      loadedCount: job?.loadedCount ?? 0,
      totalCount: job?.totalCount ?? 0,
      lastRefresh: job?.lastRefresh,
      error: job?.error
    };
  }

  private async startDefinitionsPrecache(orgUrl: string, project: string, limitedRefresh: boolean): Promise<DefinitionsPrecacheStatusResponse> {
    validateOrgUrl(orgUrl);
    if (!project) {
      throw new Error("Project is required.");
    }

    const jobKey = this.getDefinitionsJobKey(orgUrl, project);
    const existing = this.definitionJobs.get(jobKey);
    if (existing?.running) {
      return await this.getDefinitionsStatus(orgUrl, project);
    }

    const job: DefinitionsJob = {
      running: true,
      loadedCount: 0,
      totalCount: 100
    };
    this.definitionJobs.set(jobKey, job);

    void (async () => {
      try {
        const adoUrl = new URL(`${encodeURIComponent(project)}/_apis/build/definitions`, orgUrl);
        adoUrl.searchParams.set("api-version", "7.1");
        adoUrl.searchParams.set("includeLatestBuilds", "true");

        const previous = limitedRefresh
          ? await this.cacheStore.readJson<RelayDefinitionSummary[]>("GET", adoUrl.toString())
          : null;
        const fresh = await this.adoClient.listDefinitions(orgUrl, project, async (loadedCount, totalCount) => {
          job.loadedCount = loadedCount;
          job.totalCount = totalCount;
          await this.telemetry.log("relay.definitions.precache.progress", "info", {
            project,
            loadedCount,
            totalCount
          });
        });

        const merged = previous
          ? mergeDefinitions(previous.body, fresh)
          : fresh;
        const written = await this.cacheStore.writeJson("GET", adoUrl.toString(), TTL_SECONDS.definitions, merged);
        job.lastRefresh = written.lastRefresh;
        job.loadedCount = merged.length;
        job.totalCount = merged.length;
        job.running = false;
        job.error = undefined;
      } catch (error) {
        job.running = false;
        job.error = error instanceof Error ? error.message : String(error);
        await this.telemetry.log("relay.definitions.precache.error", "error", {
          project,
          message: job.error
        });
      }
    })();

    return await this.getDefinitionsStatus(orgUrl, project);
  }

  private async refresh(body: RefreshRequest): Promise<ProjectsResponse | BuildsResponse | BuildResponse | DefinitionsResponse> {
    if (body.resource === "projects") {
      return await this.loadProjects(body.orgUrl, true);
    }
    if (body.resource === "builds") {
      return await this.loadBuilds(body.orgUrl, body.project ?? "", true);
    }
    if (body.resource === "definitions") {
      return await this.loadDefinitions(body.orgUrl, body.project ?? "", true);
    }
    return await this.loadBuild(body.orgUrl, body.project ?? "", Number(body.buildId), true);
  }

  private async withCache<T, R>(options: {
    cacheUrl: string;
    ttlSeconds: number;
    forceRefresh: boolean;
    fetcher: () => Promise<T>;
    mapper: (body: T, cached: boolean, lastRefresh: string) => R;
    eventName: string;
  }): Promise<R> {
    const cacheFresh = !options.forceRefresh && await this.cacheStore.isFresh("GET", options.cacheUrl);
    await this.telemetry.log("relay.cache.check", "info", {
      event: options.eventName,
      cacheUrl: options.cacheUrl,
      cacheFresh,
      forceRefresh: options.forceRefresh
    });

    if (cacheFresh) {
      const cached = await this.cacheStore.readJson<T>("GET", options.cacheUrl);
      if (cached) {
        await this.telemetry.log("relay.cache.hit", "info", { cacheUrl: options.cacheUrl });
        return options.mapper(cached.body, true, cached.lastRefresh);
      }
    }

    await this.telemetry.log("relay.cache.miss", "info", { cacheUrl: options.cacheUrl });
    const body = await options.fetcher();
    const written = await this.cacheStore.writeJson("GET", options.cacheUrl, options.ttlSeconds, body);
    return options.mapper(written.body, false, written.lastRefresh);
  }

  private sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end(JSON.stringify(body));
  }

  private getDefinitionsJobKey(orgUrl: string, project: string): string {
    return `${new URL(orgUrl).origin}|${project}`;
  }
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw || "{}") as T;
}

function normalizeError(error: unknown): ErrorResponse {
  if (error instanceof RelayAuthError) {
    return {
      ok: false,
      code: "auth_required",
      error: error.message
    };
  }

  return {
    ok: false,
    code: "server_error",
    error: error instanceof Error ? error.message : String(error)
  };
}

function validateOrgUrl(value: string): void {
  if (!value) {
    throw new Error("Organization URL is required.");
  }

  const parsed = new URL(value);
  if (parsed.protocol !== "https:") {
    throw new Error("Organization URL must use https.");
  }
}

function mergeDefinitions(previous: RelayDefinitionSummary[], fresh: RelayDefinitionSummary[]): RelayDefinitionSummary[] {
  const byId = new Map<number, RelayDefinitionSummary>();
  for (const definition of previous) {
    byId.set(definition.id, definition);
  }
  for (const definition of fresh) {
    byId.set(definition.id, definition);
  }
  return [...byId.values()].sort((left, right) => {
    if (left.path === right.path) {
      return left.name.localeCompare(right.name);
    }
    return left.path.localeCompare(right.path);
  });
}
