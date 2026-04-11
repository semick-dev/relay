import { RelayBuildDetails, RelayBuildSummary, RelayProject } from "../shared/types";

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

  async listBuilds(orgUrl: string, project: string, limit: number): Promise<RelayBuildSummary[]> {
    const url = new URL(`${encodeURIComponent(project)}/_apis/build/builds`, normalizeOrgUrl(orgUrl));
    url.searchParams.set("$top", String(limit));
    url.searchParams.set("queryOrder", "queueTimeDescending");
    url.searchParams.set("api-version", "7.1-preview.7");
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

  private async requestJson<T>(url: string): Promise<T> {
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

    return await response.json() as T;
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
    definitionName: build.definition?.name ?? "Unknown",
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

interface AdoBuild {
  id: number;
  buildNumber: string;
  status?: string;
  result?: string;
  queueTime?: string;
  startTime?: string;
  finishTime?: string;
  sourceBranch?: string;
  reason?: string;
  definition?: {
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
