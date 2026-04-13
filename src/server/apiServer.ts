import * as http from "http";

import { RelayAdoClient, RelayAuthError } from "./adoClient";
import { RelayCacheStore } from "./cacheStore";
import { RelayStorage } from "./storage";
import { RelayTelemetrySink } from "./telemetry";
import {
  RelayArtifactDownloadResponse,
  RelayArtifactsResponse,
  RelayArtifactSummary,
  BuildResponse,
  BuildsResponse,
  DefinitionQueueMetadataResponse,
  DefinitionsPrecacheStatusResponse,
  DefinitionsResponse,
  ErrorResponse,
  ProjectsResponse,
  QueueBuildRequest,
  QueueBuildResponse,
  RefreshRequest,
  RelayBuildDetails,
  RelayBuildSummary,
  RelayDefinitionQueueMetadata,
  RelayDefinitionSummary,
  RelayProject,
  RelayTaskLogInfoResponse,
  RelayTaskLogResponse,
  RelayTimelineNode,
  RelayTimelineResponse,
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
  private readonly taskLogLoads = new Map<string, Promise<RelayTaskLogResponse>>();

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

      if (method === "GET" && requestUrl.pathname.startsWith("/api/projects/") && requestUrl.pathname.endsWith("/queue-metadata")) {
        const project = decodeURIComponent(requestUrl.pathname.split("/")[3] ?? "");
        const definitionId = Number(requestUrl.pathname.split("/")[5] ?? "0");
        const orgUrl = requestUrl.searchParams.get("orgUrl") ?? "";
        const sourceBranch = requestUrl.searchParams.get("sourceBranch") ?? "";
        const payload = await this.loadDefinitionQueueMetadata(orgUrl, project, definitionId, sourceBranch || undefined);
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

      if (method === "POST" && requestUrl.pathname.startsWith("/api/projects/") && requestUrl.pathname.endsWith("/queue")) {
        const project = decodeURIComponent(requestUrl.pathname.split("/")[3] ?? "");
        const definitionId = Number(requestUrl.pathname.split("/")[5] ?? "0");
        const orgUrl = requestUrl.searchParams.get("orgUrl") ?? "";
        const body = await readJsonBody<QueueBuildRequest>(req);
        const payload = await this.queueDefinitionBuild(orgUrl, project, definitionId, body);
        this.sendJson(res, 201, payload);
        return;
      }

      if (method === "GET" && requestUrl.pathname.startsWith("/api/builds/")) {
        const buildId = Number(requestUrl.pathname.split("/")[3] ?? "0");
        const orgUrl = requestUrl.searchParams.get("orgUrl") ?? "";
        const project = requestUrl.searchParams.get("project") ?? "";
        const refresh = requestUrl.searchParams.get("refresh") === "1";
        const pathParts = requestUrl.pathname.split("/");

        if (pathParts[4] === "timeline") {
          const payload = await this.loadTimeline(orgUrl, project, buildId, refresh);
          this.sendJson(res, 200, payload);
          return;
        }

        if (pathParts[4] === "artifacts" && !pathParts[5]) {
          const payload = await this.loadArtifacts(orgUrl, project, buildId, refresh);
          this.sendJson(res, 200, payload);
          return;
        }

        if (pathParts[4] === "logs" && pathParts[5]) {
          const logId = Number(pathParts[5]);
          if (pathParts[6] === "meta") {
            const payload = await this.getTaskLogInfo(orgUrl, project, buildId, logId, refresh);
            this.sendJson(res, 200, payload);
            return;
          }
          const payload = await this.loadTaskLog(orgUrl, project, buildId, logId, refresh);
          this.sendJson(res, 200, payload);
          return;
        }

        const payload = await this.loadBuild(orgUrl, project, buildId, refresh);
        this.sendJson(res, 200, payload);
        return;
      }

      if (method === "POST" && requestUrl.pathname.startsWith("/api/builds/")) {
        const pathParts = requestUrl.pathname.split("/");
        const buildId = Number(pathParts[3] ?? "0");
        const orgUrl = requestUrl.searchParams.get("orgUrl") ?? "";
        const project = requestUrl.searchParams.get("project") ?? "";

        if (pathParts[4] === "artifacts" && pathParts[5] === "download") {
          const body = await readJsonBody<{ artifactName?: string; targetFolder?: string }>(req);
          const payload = await this.downloadArtifact(orgUrl, project, buildId, body.artifactName ?? "", body.targetFolder ?? "");
          this.sendJson(res, 200, payload);
          return;
        }
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
    const authConfigured = this.adoClient.hasToken;
    return {
      ok: authConfigured,
      authConfigured,
      message: authConfigured
        ? "Relay is ready."
        : "Authentication token is not configured. Use the Set Token button or run \"Azure DevOps Relay: Set Token\" from the Command Palette."
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
      fetcher: async () => {
        const builds = await this.adoClient.listBuilds(orgUrl, project, 10, definitionId);
        return await Promise.all(builds.map(async (build) => ({
          ...build,
          commitMessage: await this.adoClient.getBuildChanges(orgUrl, project, build.id)
        })));
      },
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

  private async loadDefinitionQueueMetadata(
    orgUrl: string,
    project: string,
    definitionId: number,
    sourceBranch?: string
  ): Promise<DefinitionQueueMetadataResponse> {
    validateOrgUrl(orgUrl);
    if (!project || !Number.isFinite(definitionId) || definitionId <= 0) {
      throw new Error("Project and definitionId are required.");
    }

    const definition = await this.adoClient.getDefinitionQueueMetadata(orgUrl, project, definitionId, sourceBranch);
    return {
      ok: true,
      projectName: project,
      definition
    };
  }

  private async queueDefinitionBuild(
    orgUrl: string,
    project: string,
    definitionId: number,
    body: QueueBuildRequest
  ): Promise<QueueBuildResponse> {
    validateOrgUrl(orgUrl);
    if (!project || !Number.isFinite(definitionId) || definitionId <= 0) {
      throw new Error("Project and definitionId are required.");
    }

    const build = await this.adoClient.queueBuild(orgUrl, project, definitionId, body);
    return {
      ok: true,
      build
    };
  }

  private async loadTimeline(orgUrl: string, project: string, buildId: number, forceRefresh: boolean): Promise<RelayTimelineResponse> {
    const build = await this.loadBuild(orgUrl, project, buildId, forceRefresh);
    const completed = isBuildCompleted(build.build);
    const localTimestamp = await this.storage.readBuildTimestamp(buildId);
    const cachedTimeline = completed && !forceRefresh
      ? await this.storage.readBuildJson<RelayTimelineNode[]>(buildId, "timeline.json")
      : null;

    if (cachedTimeline) {
      return {
        ok: true,
        buildId,
        cached: true,
        lastRefresh: localTimestamp ?? build.build.lastRefresh,
        timeline: cachedTimeline
      };
    }

    const timeline = await this.adoClient.getTimeline(orgUrl, project, buildId);
    const timestamp = new Date().toISOString();
    await this.storage.writeBuildJson(buildId, "timeline.json", timeline);
    await this.storage.writeBuildTimestamp(buildId, timestamp);

    return {
      ok: true,
      buildId,
      cached: false,
      lastRefresh: timestamp,
      timeline
    };
  }

  private async loadTaskLog(orgUrl: string, project: string, buildId: number, logId: number, forceRefresh: boolean): Promise<RelayTaskLogResponse> {
    const build = await this.loadBuild(orgUrl, project, buildId, forceRefresh);
    const completed = isBuildCompleted(build.build);
    const relativePath = `logs/${logId}.txt`;
    const localTimestamp = await this.storage.readBuildTimestamp(buildId);
    const cachedLog = completed && !forceRefresh
      ? await this.storage.readBuildText(buildId, relativePath)
      : null;

    if (cachedLog !== null) {
      const sizeBytes = Buffer.byteLength(cachedLog, "utf8");
      return this.buildTaskLogResponse(buildId, logId, true, localTimestamp ?? build.build.lastRefresh, cachedLog, relativePath, sizeBytes);
    }

    const taskLogKey = this.getTaskLogKey(buildId, logId);
    const inFlight = this.taskLogLoads.get(taskLogKey);
    if (inFlight) {
      return await inFlight;
    }

    const loadPromise = (async () => {
      const content = await this.adoClient.getLog(orgUrl, project, buildId, logId);
      const timestamp = new Date().toISOString();
      await this.storage.writeBuildTimestamp(buildId, timestamp);
      const sizeBytes = Buffer.byteLength(content, "utf8");

      await this.storage.writeBuildText(buildId, relativePath, content);

      return this.buildTaskLogResponse(buildId, logId, false, timestamp, content, relativePath, sizeBytes);
    })();

    this.taskLogLoads.set(taskLogKey, loadPromise);
    try {
      return await loadPromise;
    } finally {
      this.taskLogLoads.delete(taskLogKey);
    }
  }

  private async getTaskLogInfo(orgUrl: string, project: string, buildId: number, logId: number, forceRefresh: boolean): Promise<RelayTaskLogInfoResponse> {
    const build = await this.loadBuild(orgUrl, project, buildId, forceRefresh);
    const completed = isBuildCompleted(build.build);
    const relativePath = `logs/${logId}.txt`;
    const cached = completed ? await this.storage.hasBuildFile(buildId, relativePath) : false;
    const sizeBytes = cached
      ? await this.storage.getBuildFileSize(buildId, relativePath)
      : await this.adoClient.getLogSize(orgUrl, project, buildId, logId);
    const timeline = await this.loadTimeline(orgUrl, project, buildId, false);
    const record = findTimelineNodeByLogId(timeline.timeline, logId);
    const lastRefresh = await this.storage.readBuildTimestamp(buildId) ?? build.build.lastRefresh;
    const lineCount = record?.logLineCount;
    const isLarge = typeof sizeBytes === "number"
      ? sizeBytes >= 1024 * 1024
      : typeof lineCount === "number"
        ? estimateLargeLog(lineCount)
        : false;

    return {
      ok: true,
      buildId,
      logId,
      cached,
      lastRefresh,
      lineCount,
      sizeBytes: sizeBytes ?? undefined,
      downloadPath: cached ? this.storage.getBuildFilePath(buildId, relativePath) : undefined,
      isLarge,
      shouldDelayDownload: isLarge
    };
  }

  private async loadArtifacts(orgUrl: string, project: string, buildId: number, forceRefresh: boolean): Promise<RelayArtifactsResponse> {
    const build = await this.loadBuild(orgUrl, project, buildId, forceRefresh);
    const completed = isBuildCompleted(build.build);
    const rawDownloadState = await this.storage.readBuildJson<Record<string, string>>(buildId, "artifacts-downloads.json") ?? {};
    const downloadState = await this.filterExistingArtifactDownloads(rawDownloadState);
    if (Object.keys(downloadState).length !== Object.keys(rawDownloadState).length) {
      await this.storage.writeBuildJson(buildId, "artifacts-downloads.json", downloadState);
    }
    const cachedArtifacts = completed && !forceRefresh
      ? await this.storage.readBuildJson<RelayArtifactSummary[]>(buildId, "artifacts.json")
      : null;
    const timestamp = await this.storage.readBuildTimestamp(buildId) ?? build.build.lastRefresh;

    if (cachedArtifacts) {
      return {
        ok: true,
        buildId,
        cached: true,
        lastRefresh: timestamp,
        artifacts: applyArtifactDownloadState(cachedArtifacts, downloadState)
      };
    }

    const artifacts = await this.adoClient.listArtifacts(orgUrl, project, buildId);
    const refreshed = new Date().toISOString();
    await this.storage.writeBuildJson(buildId, "artifacts.json", artifacts);
    await this.storage.writeBuildTimestamp(buildId, refreshed);
    return {
      ok: true,
      buildId,
      cached: false,
      lastRefresh: refreshed,
      artifacts: applyArtifactDownloadState(artifacts, downloadState)
    };
  }

  private async downloadArtifact(orgUrl: string, project: string, buildId: number, artifactName: string, targetFolder: string): Promise<RelayArtifactDownloadResponse> {
    if (!artifactName || !targetFolder) {
      throw new Error("artifactName and targetFolder are required.");
    }

    const artifacts = await this.loadArtifacts(orgUrl, project, buildId, false);
    const artifact = artifacts.artifacts.find((item) => item.name === artifactName);
    if (!artifact?.downloadUrl) {
      throw new Error(`Artifact ${artifactName} does not have a download URL.`);
    }

    const bytes = await this.adoClient.downloadArtifact(artifact.downloadUrl);
    const safeName = artifact.name.replace(/[^\w.-]+/g, "_");
    const extension = artifact.resourceType === "FilePath" ? "" : ".zip";
    const savedPath = `${targetFolder}/${safeName}${extension}`;
    await this.storage.writeFileBytes(savedPath, bytes);
    const downloadState = await this.storage.readBuildJson<Record<string, string>>(buildId, "artifacts-downloads.json") ?? {};
    downloadState[artifactName] = savedPath;
    await this.storage.writeBuildJson(buildId, "artifacts-downloads.json", downloadState);

    return {
      ok: true,
      buildId,
      artifactName,
      savedPath
    };
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

    const adoUrl = new URL(`${encodeURIComponent(project)}/_apis/build/definitions`, orgUrl);
    adoUrl.searchParams.set("api-version", "7.1");

    if (limitedRefresh && await this.cacheStore.isFresh("GET", adoUrl.toString())) {
      const cached = await this.cacheStore.readJson<RelayDefinitionSummary[]>("GET", adoUrl.toString());
      return {
        ok: true,
        projectName: project,
        running: false,
        loadedCount: cached?.body.length ?? 0,
        totalCount: cached?.body.length ?? 0,
        lastRefresh: cached?.lastRefresh,
        error: undefined
      };
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

  private getTaskLogKey(buildId: number, logId: number): string {
    return `${buildId}:${logId}`;
  }

  private buildTaskLogResponse(
    buildId: number,
    logId: number,
    cached: boolean,
    lastRefresh: string,
    content: string,
    relativePath: string,
    sizeBytes: number
  ): RelayTaskLogResponse {
    if (sizeBytes >= 1024 * 1024) {
      return {
        ok: true,
        buildId,
        logId,
        cached,
        lastRefresh,
        inline: false,
        sizeBytes,
        downloadPath: this.storage.getBuildFilePath(buildId, relativePath)
      };
    }

    return {
      ok: true,
      buildId,
      logId,
      cached,
      lastRefresh,
      inline: true,
      sizeBytes,
      content
    };
  }

  private async filterExistingArtifactDownloads(downloadState: Record<string, string>): Promise<Record<string, string>> {
    const entries = await Promise.all(
      Object.entries(downloadState).map(async ([artifactName, savedPath]) => (
        await this.storage.pathExists(savedPath) ? [artifactName, savedPath] : null
      ))
    );

    return Object.fromEntries(entries.filter((entry): entry is [string, string] => entry !== null));
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

function isBuildCompleted(build: RelayBuildDetails): boolean {
  return build.status === "completed" || Boolean(build.finishTime);
}

function applyArtifactDownloadState(
  artifacts: RelayArtifactSummary[],
  downloadState: Record<string, string>
): RelayArtifactSummary[] {
  return artifacts.map((artifact) => ({
    ...artifact,
    downloadedPath: downloadState[artifact.name]
  }));
}

function findTimelineNodeByLogId(nodes: RelayTimelineNode[], logId: number): RelayTimelineNode | null {
  for (const node of nodes) {
    if (node.logId === logId) {
      return node;
    }
    const nested = findTimelineNodeByLogId(node.children, logId);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function estimateLargeLog(lineCount?: number): boolean {
  if (!lineCount) {
    return false;
  }
  return lineCount >= 8000;
}
