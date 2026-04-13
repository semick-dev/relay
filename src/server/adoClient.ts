import {
  RelayArtifactSummary,
  RelayBuildDetails,
  RelayBuildSummary,
  RelayDefinitionParameter,
  RelayDefinitionParameterOption,
  RelayDefinitionSummary,
  RelayDefinitionQueueMetadata,
  RelayDefinitionVariable,
  RelayProject,
  RelayTimelineNode
} from "../shared/types";

export class RelayAuthError extends Error {}
export class RelayHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly responseText?: string
  ) {
    super(message);
  }
}

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
      const response = await this.requestDefinitionsPage(orgUrl, project, continuationToken);
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

  async getDefinitionQueueMetadata(orgUrl: string, project: string, definitionId: number): Promise<RelayDefinitionQueueMetadata> {
    const url = new URL(`${encodeURIComponent(project)}/_apis/build/definitions/${definitionId}`, normalizeOrgUrl(orgUrl));
    url.searchParams.set("api-version", "7.1");
    const payload = await this.requestJson<AdoDefinition>(url.toString());
    return {
      id: payload.id,
      name: payload.name,
      path: payload.path || "\\",
      queueStatus: payload.queueStatus,
      defaultBranch: payload.repository?.defaultBranch,
      repositoryType: payload.repository?.type,
      repositoryName: payload.repository?.name,
      parameters: mapDefinitionParameters(payload.processParameters),
      variables: mapDefinitionVariables(payload.variables)
    };
  }

  async queueBuild(
    orgUrl: string,
    project: string,
    definitionId: number,
    options: {
      sourceBranch?: string;
      parameters?: Record<string, string> | string;
      variables?: Record<string, string>;
    }
  ): Promise<RelayBuildDetails> {
    const url = new URL(`${encodeURIComponent(project)}/_apis/build/builds`, normalizeOrgUrl(orgUrl));
    url.searchParams.set("api-version", "7.1");
    this.ensureAuth();

    const body: AdoQueueBuildRequest = {
      definition: { id: definitionId }
    };
    if (options.sourceBranch) {
      body.sourceBranch = options.sourceBranch;
    }
    if (typeof options.parameters === "string") {
      body.parameters = options.parameters;
    } else if (options.parameters && Object.keys(options.parameters).length > 0) {
      body.parameters = JSON.stringify(options.parameters);
    }
    if (options.variables && Object.keys(options.variables).length > 0) {
      body.variables = Object.fromEntries(
        Object.entries(options.variables).map(([name, value]) => [name, { value }])
      );
    }

    const auth = Buffer.from(`:${this.token ?? ""}`, "utf8").toString("base64");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const responseText = await response.text();
      const trimmed = responseText.trim();
      const detail = trimmed ? `: ${trimmed}` : "";
      throw new RelayHttpError(`ADO queue request failed (${response.status}) for ${url}${detail}`, response.status, url.toString(), trimmed || undefined);
    }

    const payload = await response.json() as AdoBuild;
    return {
      ...mapBuildSummary(payload),
      projectName: payload.project?.name ?? project,
      repository: payload.repository?.name,
      reason: payload.reason,
      cached: false,
      lastRefresh: new Date().toISOString()
    };
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

  async getLogSize(orgUrl: string, project: string, buildId: number, logId: number): Promise<number | undefined> {
    const url = new URL(`${encodeURIComponent(project)}/_apis/build/builds/${buildId}/logs/${logId}`, normalizeOrgUrl(orgUrl));
    url.searchParams.set("api-version", "7.1");
    this.ensureAuth();

    const auth = Buffer.from(`:${this.token ?? ""}`, "utf8").toString("base64");
    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "text/plain"
      }
    });

    if (response.ok) {
      const length = response.headers.get("content-length");
      const parsed = parseSizeHeader(length);
      if (parsed !== undefined) {
        return parsed;
      }
    }

    const ranged = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "text/plain",
        Range: "bytes=0-0"
      }
    });

    if (!ranged.ok) {
      return undefined;
    }

    const contentRange = ranged.headers.get("content-range");
    const fromRange = parseContentRangeSize(contentRange);
    if (fromRange !== undefined) {
      return fromRange;
    }

    return parseSizeHeader(ranged.headers.get("content-length"));
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

  private async requestDefinitionsPage(
    orgUrl: string,
    project: string,
    continuationToken?: string
  ): Promise<{ body: AdoDefinitionsResponse; continuationToken?: string }> {
    const url = new URL(`${encodeURIComponent(project)}/_apis/build/definitions`, normalizeOrgUrl(orgUrl));
    url.searchParams.set("$top", "100");
    url.searchParams.set("queryOrder", "lastModifiedDescending");
    url.searchParams.set("api-version", "7.1");
    if (continuationToken) {
      url.searchParams.set("continuationToken", continuationToken);
    }
    return await this.request<AdoDefinitionsResponse>(url.toString());
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
      const responseText = await response.text();
      const trimmed = responseText.trim();
      const detail = trimmed ? `: ${trimmed}` : "";
      throw new RelayHttpError(`ADO request failed (${response.status}) for ${url}${detail}`, response.status, url, trimmed || undefined);
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

function parseSizeHeader(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseContentRangeSize(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = /\/(\d+)$/.exec(value);
  if (!match) {
    return undefined;
  }
  return parseSizeHeader(match[1] ?? null);
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

interface AdoDefinition {
  id: number;
  name: string;
  path?: string;
  revision?: number;
  queueStatus?: string;
  variables?: Record<string, AdoDefinitionVariable>;
  processParameters?: {
    inputs?: AdoProcessInput[];
  };
  repository?: {
    type?: string;
    name?: string;
    defaultBranch?: string;
  };
}

interface AdoDefinitionVariable {
  value?: string;
  allowOverride?: boolean;
  isSecret?: boolean;
}

interface AdoProcessInput {
  name?: string;
  type?: string;
  label?: string;
  defaultValue?: unknown;
  required?: boolean;
  options?: Record<string, string> | string[];
}

interface AdoQueueBuildRequest {
  definition: {
    id: number;
  };
  sourceBranch?: string;
  parameters?: string;
  variables?: Record<string, { value: string }>;
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

function mapDefinitionVariables(
  variables?: Record<string, AdoDefinitionVariable>
): RelayDefinitionVariable[] {
  return Object.entries(variables ?? {})
    .map(([name, variable]) => ({
      name,
      value: variable.value,
      allowOverride: Boolean(variable.allowOverride),
      isSecret: Boolean(variable.isSecret)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function mapDefinitionParameters(
  processParameters?: { inputs?: AdoProcessInput[] }
): RelayDefinitionParameter[] {
  return (processParameters?.inputs ?? [])
    .filter((input) => typeof input.name === "string" && input.name)
    .map((input) => ({
      name: input.name ?? "",
      type: input.type,
      label: input.label,
      defaultValue: stringifyProcessInputValue(input.defaultValue),
      required: Boolean(input.required),
      options: mapDefinitionParameterOptions(input.options)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function mapDefinitionParameterOptions(
  options?: Record<string, string> | string[]
): RelayDefinitionParameterOption[] {
  if (Array.isArray(options)) {
    return options.map((value) => ({ label: value, value }));
  }
  return Object.entries(options ?? {}).map(([value, label]) => ({
    value,
    label: label || value
  }));
}

function stringifyProcessInputValue(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
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
