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
import { parseDocument, Scalar, YAMLMap, YAMLSeq } from "yaml";

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
  constructor(private token: string | undefined) {}

  get hasToken(): boolean {
    return Boolean(this.token);
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  ensureAuth(): void {
    if (!this.token) {
      throw new RelayAuthError(
        "ADO token is not configured. Run \"Azure DevOps Relay: Set Token\" from the Command Palette."
      );
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

  async getDefinitionQueueMetadata(
    orgUrl: string,
    project: string,
    definitionId: number,
    sourceBranch?: string
  ): Promise<RelayDefinitionQueueMetadata> {
    const url = new URL(`${encodeURIComponent(project)}/_apis/build/definitions/${definitionId}`, normalizeOrgUrl(orgUrl));
    url.searchParams.set("api-version", "7.1");
    const payload = await this.requestJson<AdoDefinition>(url.toString());
    const isYaml = payload.process?.type === 2;
    const branch = sourceBranch
      ? normalizeBranchRef(sourceBranch)
      : payload.repository?.defaultBranch
        ? normalizeBranchRef(payload.repository.defaultBranch)
        : undefined;
    let parameters: RelayDefinitionParameter[] = [];
    let parameterError: string | undefined;
    if (isYaml) {
      try {
        parameters = await this.getYamlTemplateParameters(orgUrl, project, definitionId, branch);
      } catch (error) {
        parameterError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      id: payload.id,
      name: payload.name,
      path: payload.path || "\\",
      isYaml,
      yamlFilename: payload.process?.yamlFilename,
      parameterError,
      queueStatus: payload.queueStatus,
      defaultBranch: branch,
      repositoryType: payload.repository?.type,
      repositoryName: payload.repository?.name,
      parameters,
      variables: mapDefinitionVariables(payload.variables)
    };
  }

  async queueBuild(
    orgUrl: string,
    project: string,
    definitionId: number,
    options: {
      sourceBranch?: string;
      parameters?: Record<string, unknown>;
      variables?: Record<string, string>;
    }
  ): Promise<RelayBuildDetails> {
    const definition = await this.getDefinitionQueueMetadata(orgUrl, project, definitionId, options.sourceBranch);
    if (!definition.isYaml) {
      throw new Error("Only YAML-backed definitions are supported for queueing.");
    }

    const url = new URL(`${encodeURIComponent(project)}/_apis/pipelines/${definitionId}/runs`, normalizeOrgUrl(orgUrl));
    url.searchParams.set("api-version", "7.1");
    this.ensureAuth();

    const body: AdoRunPipelineRequest = {};
    const sourceBranch = options.sourceBranch ? normalizeBranchRef(options.sourceBranch) : definition.defaultBranch;
    if (sourceBranch) {
      body.resources = {
        repositories: {
          self: {
            refName: sourceBranch
          }
        }
      };
    }
    if (options.parameters && Object.keys(options.parameters).length > 0) {
      body.templateParameters = normalizeTemplateParameters(options.parameters);
    }
    if (options.variables && Object.keys(options.variables).length > 0) {
      body.variables = Object.fromEntries(
        Object.entries(options.variables).map(([name, value]) => [name, { value }])
      );
    }

    const payload = await this.requestWithBodyJson<AdoPipelineRun>(url.toString(), body);
    return await this.getBuild(orgUrl, project, payload.id);
  }

  private async getYamlTemplateParameters(
    orgUrl: string,
    project: string,
    definitionId: number,
    sourceBranch?: string
  ): Promise<RelayDefinitionParameter[]> {
    const url = new URL(`${encodeURIComponent(project)}/_apis/pipelines/${definitionId}/preview`, normalizeOrgUrl(orgUrl));
    url.searchParams.set("api-version", "7.1");
    const preview = await this.requestWithBodyJson<AdoPipelinePreview>(url.toString(), {
      previewRun: true,
      resources: sourceBranch ? {
        repositories: {
          self: {
            refName: sourceBranch
          }
        }
      } : undefined
    });
    return mapYamlDefinitionParameters(preview.finalYaml || "");
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

  private async requestWithBodyJson<T>(url: string, body: unknown): Promise<T> {
    const response = await this.request<T>(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    return response.body;
  }

  private async requestText(url: string): Promise<string> {
    this.ensureAuth();

    const auth = Buffer.from(`:${this.token ?? ""}`, "utf8").toString("base64");
    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "text/plain, application/yaml, text/yaml, application/json"
      }
    });

    if (!response.ok) {
      const responseText = await response.text();
      const trimmed = responseText.trim();
      const detail = trimmed ? `: ${trimmed}` : "";
      throw new RelayHttpError(`ADO request failed (${response.status}) for ${url}${detail}`, response.status, url, trimmed || undefined);
    }

    return await response.text();
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

  private async request<T>(
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }
  ): Promise<{ body: T; continuationToken?: string }> {
    this.ensureAuth();

    const auth = Buffer.from(`:${this.token ?? ""}`, "utf8").toString("base64");
    const response = await fetch(url, {
      method: init?.method,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        ...init?.headers
      },
      body: init?.body
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
  processParameters?: string | {
    inputs?: AdoProcessInput[];
  };
  process?: {
    type?: number;
    yamlFilename?: string;
  };
  repository?: {
    type?: string;
    name?: string;
    defaultBranch?: string;
  };
  project?: {
    id?: string;
    name?: string;
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

interface AdoRunPipelineRequest {
  resources?: {
    repositories?: {
      self?: {
        refName?: string;
      };
    };
  };
  templateParameters?: Record<string, unknown>;
  variables?: Record<string, { value: string }>;
}

interface AdoPipelineRun {
  id: number;
}

interface AdoPipelinePreview {
  finalYaml?: string;
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
    .filter(([, variable]) => Boolean(variable.allowOverride))
    .map(([name, variable]) => ({
      name,
      value: variable.value,
      allowOverride: Boolean(variable.allowOverride),
      isSecret: Boolean(variable.isSecret)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function mapDefinitionParameters(
  processParameters?: string | { inputs?: AdoProcessInput[] }
): RelayDefinitionParameter[] {
  const parsed = parseDefinitionProcessParameters(processParameters);
  return (parsed?.inputs ?? [])
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

function parseDefinitionProcessParameters(
  processParameters?: string | { inputs?: AdoProcessInput[] }
): { inputs?: AdoProcessInput[] } | undefined {
  if (!processParameters) {
    return undefined;
  }
  if (typeof processParameters === "string") {
    try {
      const parsed = JSON.parse(processParameters) as { inputs?: AdoProcessInput[] };
      return parsed && typeof parsed === "object" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return processParameters;
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

function normalizeBranchRef(value: string): string {
  if (!value) {
    return value;
  }
  if (value.startsWith("refs/")) {
    return value;
  }
  return `refs/heads/${value}`;
}

function normalizeTemplateParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(parameters).map(([name, value]) => [name, normalizeTemplateParameterValue(name, value)])
  );
}

function normalizeTemplateParameterValue(name: string, value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  try {
    return parseDocument(value).toJS();
  } catch (error) {
    throw new Error(`Invalid YAML for parameter "${name}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

function mapYamlDefinitionParameters(yamlText: string): RelayDefinitionParameter[] {
  const document = parseDocument(yamlText);
  const root = document.contents;
  if (!(root instanceof YAMLMap)) {
    return [];
  }

  const parametersNode = root.get("parameters", true);
  if (!parametersNode) {
    return [];
  }

  if (parametersNode instanceof YAMLSeq) {
    return parametersNode.items
      .map((item) => mapYamlParameterNode(item))
      .filter((item): item is RelayDefinitionParameter => Boolean(item))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  if (parametersNode instanceof YAMLMap) {
    const mapped: RelayDefinitionParameter[] = [];
    for (const pair of parametersNode.items) {
        const name = scalarToString(pair.key);
        if (!name) {
          continue;
        }
        mapped.push({
          name,
          type: "string",
          label: name,
          defaultValue: stringifyYamlValueNode(pair.value),
          required: false,
          options: []
        });
    }
    return mapped.sort((left, right) => left.name.localeCompare(right.name));
  }

  return [];
}

function mapYamlParameterNode(node: unknown): RelayDefinitionParameter | null {
  if (!(node instanceof YAMLMap)) {
    return null;
  }

  const name = scalarToString(node.get("name", true));
  if (!name) {
    return null;
  }

  const type = scalarToString(node.get("type", true)) || "string";
  const displayName = scalarToString(node.get("displayName", true));
  const valuesNode = node.get("values", true);
  const options = valuesNode instanceof YAMLSeq
    ? valuesNode.items
        .map((item) => scalarToString(item))
        .filter((value): value is string => Boolean(value))
        .map((value) => ({ label: value, value }))
    : [];

  return {
    name,
    type,
    label: displayName || name,
    defaultValue: stringifyYamlValueNode(node.get("default", true)),
    required: false,
    options
  };
}

function stringifyYamlValueNode(node: unknown): string | undefined {
  if (node === null || node === undefined) {
    return undefined;
  }
  if (node instanceof Scalar) {
    return stringifyProcessInputValue(node.value);
  }
  return String(node).trimEnd();
}

function scalarToString(node: unknown): string | undefined {
  if (node instanceof Scalar) {
    return stringifyProcessInputValue(node.value);
  }
  if (typeof node === "string") {
    return node;
  }
  return undefined;
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
