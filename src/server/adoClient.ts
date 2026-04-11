import {
  RelayArtifactSummary,
  RelayBuildDetails,
  RelayBuildSummary,
  RelayDefinitionSummary,
  RelayProject,
  RelayTimelineNode
} from "../shared/types";

export class RelayAuthError extends Error {}

export class RelayAdoClient {
  constructor(private readonly token: string | undefined) {}

  ensureAuth(): void {
    if (!this.token) {
      throw new RelayAuthError("ADO_TOKEN is not configured.");
    }
  }

  async listProjects(orgUrl: string): Promise<RelayProject[]> {
    const url = new URL("_apis/projects", normalizeOrgUrl(orgUrl));
    url.searchParams.set("api-version", "7.1-preview.4");
    const payload = await this.requestJson<AdoProjectsResponse>(url.toString());
    return payload.value.map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description,
      state: project.state
    }));
  }

  async listBuilds(orgUrl: string, project: string, limit: number, definitionId?: number): Promise<RelayBuildSummary[]> {
    const url = new URL(`${encodeURIComponent(project)}/_apis/build/builds`, normalizeOrgUrl(orgUrl));
    url.searchParams.set("$top", String(limit));
    url.searchParams.set("queryOrder", "queueTimeDescending");
    url.searchParams.set("api-version", "7.1-preview.7");
    if (definitionId) {
      url.searchParams.set("definitions", String(definitionId));
    }
    const payload = await this.requestJson<AdoBuildsResponse>(url.toString());
    return payload.value.map(mapBuildSummary);
  }

  async getBuild(orgUrl: string, project: string, buildId: number): Promise<RelayBuildDetails> {
    const url = new URL(`${encodeURIComponent(project)}/_apis/build/builds/${buildId}`, normalizeOrgUrl(orgUrl));
    url.searchParams.set("api-version", "7.1-preview.7");
    const payload = await this.requestJson<AdoBuild>(url.toString());
    return {
      ...mapBuildSummary(payload),
      projectName: payload.project?.name ?? project,
      repository: payload.repository?.name,
      reason: payload.reason,
      cached: false,
      lastRefresh: new Date().toISOString()
    };
  }

  async listDefinitions(
    orgUrl: string,
    project: string,
    onProgress?: (loadedCount: number, totalCount: number) => Promise<void> | void
  ): Promise<RelayDefinitionSummary[]> {
    const definitions: RelayDefinitionSummary[] = [];
    let continuationToken: string | undefined;

    do {
      const url = new URL(`${encodeURIComponent(project)}/_apis/build/definitions`, normalizeOrgUrl(orgUrl));
      url.searchParams.set("api-version", "7.1");
      url.searchParams.set("includeLatestBuilds", "true");
      url.searchParams.set("$top", "100");
      if (continuationToken) {
        url.searchParams.set("continuationToken", continuationToken);
      }

      const response = await this.request<AdoDefinitionsResponse>(url.toString());
      definitions.push(...response.body.value.map((definition) => ({
        id: definition.id,
        name: definition.name,
        path: definition.path || "\\",
        revision: definition.revision ?? 0,
        queueStatus: definition.queueStatus,
        latestBuild: definition.latestBuild ? {
          id: definition.latestBuild.id,
          status: definition.latestBuild.status,
          result: definition.latestBuild.result,
          finishTime: definition.latestBuild.finishTime
        } : undefined
      })));

      continuationToken = response.continuationToken;
      if (onProgress) {
        const loadedCount = definitions.length;
        const totalCount = continuationToken ? loadedCount + 100 : loadedCount;
        await onProgress(loadedCount, totalCount);
      }
    } while (continuationToken);

    return definitions.sort((left, right) => {
      if (left.path === right.path) {
        return left.name.localeCompare(right.name);
      }
      return left.path.localeCompare(right.path);
    });
  }

  async getTimeline(orgUrl: string, project: string, buildId: number): Promise<RelayTimelineNode[]> {
    const url = new URL(`${encodeURIComponent(project)}/_apis/build/builds/${buildId}/timeline`, normalizeOrgUrl(orgUrl));
    url.searchParams.set("api-version", "7.1");
    const payload = await this.requestJson<AdoTimelineResponse>(url.toString());
    return mapTimeline(payload.records ?? []);
  }

  async getLog(orgUrl: string, project: string, buildId: number, logId: number): Promise<string> {
    const url = new URL(`${encodeURIComponent(project)}/_apis/build/builds/${buildId}/logs/${logId}`, normalizeOrgUrl(orgUrl));
    url.searchParams.set("api-version", "7.1");
    this.ensureAuth();

    const auth = Buffer.from(`:${this.token ?? ""}`, "utf8").toString("base64");
    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "text/plain"
      }
    });

    if (!response.ok) {
      throw new Error(`ADO log request failed (${response.status}) for ${url}`);
    }

    return await response.text();
  }

  async getBuildChanges(orgUrl: string, project: string, buildId: number): Promise<string | undefined> {
    const url = new URL(`${encodeURIComponent(project)}/_apis/build/builds/${buildId}/changes`, normalizeOrgUrl(orgUrl));
    url.searchParams.set("api-version", "7.1");
    const payload = await this.requestJson<AdoBuildChangesResponse>(url.toString());
    return payload.value?.[0]?.message;
  }

  async listArtifacts(orgUrl: string, project: string, buildId: number): Promise<RelayArtifactSummary[]> {
    const url = new URL(`${encodeURIComponent(project)}/_apis/build/builds/${buildId}/artifacts`, normalizeOrgUrl(orgUrl));
    url.searchParams.set("api-version", "7.1");
    const payload = await this.requestJson<AdoArtifactsResponse>(url.toString());
    return (payload.value ?? []).map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      resourceType: artifact.resource?.type,
      downloadUrl: artifact.resource?.downloadUrl
    }));
  }

  async downloadArtifact(downloadUrl: string): Promise<Buffer> {
    this.ensureAuth();
    const auth = Buffer.from(`:${this.token ?? ""}`, "utf8").toString("base64");
    const response = await fetch(downloadUrl, {
      headers: {
        Authorization: `Basic ${auth}`
      }
    });

    if (!response.ok) {
      throw new Error(`ADO artifact download failed (${response.status}) for ${downloadUrl}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  private async requestJson<T>(url: string): Promise<T> {
    const response = await this.request<T>(url);
    return response.body;
  }

  private async request<T>(url: string): Promise<{ body: T; continuationToken?: string }> {
    this.ensureAuth();

    const auth = Buffer.from(`:${this.token ?? ""}`, "utf8").toString("base64");
    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`ADO request failed (${response.status}) for ${url}`);
    }

    const continuationToken = response.headers.get("x-ms-continuationtoken") ?? undefined;
    return {
      body: await response.json() as T,
      continuationToken
    };
  }
}

function normalizeOrgUrl(value: string): string {
  const parsed = new URL(value);
  if (!parsed.pathname.endsWith("/")) {
    parsed.pathname = `${parsed.pathname}/`;
  }
  return parsed.toString();
}

function mapBuildSummary(build: AdoBuild): RelayBuildSummary {
  return {
    id: build.id,
    buildNumber: build.buildNumber,
    definitionId: build.definition?.id,
    definitionName: build.definition?.name ?? "Unknown",
    commitMessage: build.sourceVersionMessage,
    status: build.status ?? "unknown",
    result: build.result ?? "unknown",
    queueTime: build.queueTime,
    startTime: build.startTime,
    finishTime: build.finishTime,
    sourceBranch: build.sourceBranch,
    requestedFor: build.requestedFor?.displayName
  };
}

interface AdoProjectsResponse {
  value: Array<{
    id: string;
    name: string;
    description?: string;
    state?: string;
  }>;
}

interface AdoBuildsResponse {
  value: AdoBuild[];
}

interface AdoDefinitionsResponse {
  value: Array<{
    id: number;
    name: string;
    path?: string;
    revision?: number;
    queueStatus?: string;
    latestBuild?: {
      id?: number;
      status?: string;
      result?: string;
      finishTime?: string;
    };
  }>;
}

interface AdoBuild {
  id: number;
  buildNumber: string;
  status?: string;
  result?: string;
  queueTime?: string;
  startTime?: string;
  finishTime?: string;
  sourceBranch?: string;
  sourceVersionMessage?: string;
  reason?: string;
  definition?: {
    id?: number;
    name?: string;
  };
  project?: {
    name?: string;
  };
  repository?: {
    name?: string;
  };
  requestedFor?: {
    displayName?: string;
  };
}

interface AdoTimelineResponse {
  records?: AdoTimelineRecord[];
}

interface AdoArtifactsResponse {
  value?: Array<{
    id?: number;
    name: string;
    resource?: {
      type?: string;
      downloadUrl?: string;
    };
  }>;
}

interface AdoBuildChangesResponse {
  value?: Array<{
    message?: string;
  }>;
}

interface AdoTimelineRecord {
  id: string;
  parentId?: string;
  type?: string;
  name?: string;
  order?: number;
  state?: string;
  result?: string;
  startTime?: string;
  finishTime?: string;
  log?: {
    id?: number;
    lineCount?: number;
  };
}

function mapTimeline(records: AdoTimelineRecord[]): RelayTimelineNode[] {
  const byId = new Map<string, RelayTimelineNode>();
  for (const record of records) {
    byId.set(record.id, {
      id: record.id,
      parentId: record.parentId,
      type: record.type ?? "Record",
      name: record.name ?? record.type ?? "Unnamed",
      order: record.order ?? 0,
      state: record.state ?? "unknown",
      result: record.result ?? "unknown",
      startTime: record.startTime,
      finishTime: record.finishTime,
      logId: record.log?.id,
      logLineCount: record.log?.lineCount,
      children: []
    });
  }

  const roots: RelayTimelineNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)?.children.push(node);
      continue;
    }
    roots.push(node);
  }

  const sortNodes = (nodes: RelayTimelineNode[]): void => {
    nodes.sort((left, right) => {
      if (left.order === right.order) {
        return left.name.localeCompare(right.name);
      }
      return left.order - right.order;
    });
    for (const node of nodes) {
      sortNodes(node.children);
    }
  };

  sortNodes(roots);
  return roots;
}
