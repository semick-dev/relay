export type LayoutMode = "main" | "split";

export type ThemeId = "githubdark" | "neon" | "nightwave" | "ember";

export interface RelayPersistedState {
  activeTheme: ThemeId;
  orgUrl: string;
}

export interface RelayBootstrap {
  apiBase: string;
  telemetryBase: string;
  savedState: RelayPersistedState;
  themeIds: ThemeId[];
  themeUrls: Record<ThemeId, string>;
}

export interface RelayPanelBootstrap extends RelayBootstrap {
  initialProject?: string;
  initialView?: RelaySubview;
}

export interface SessionResponse {
  ok: boolean;
  authConfigured: boolean;
  message: string;
}

export interface RelayProject {
  id: string;
  name: string;
  description?: string;
  state?: string;
}

export interface RelayBuildSummary {
  id: number;
  buildNumber: string;
  definitionId?: number;
  definitionName: string;
  commitMessage?: string;
  status: string;
  result: string;
  queueTime?: string;
  startTime?: string;
  finishTime?: string;
  sourceBranch?: string;
  requestedFor?: string;
}

export interface RelayBuildDetails extends RelayBuildSummary {
  projectName: string;
  repository?: string;
  reason?: string;
  lastRefresh: string;
  cached: boolean;
}

export interface RelayTimelineNode {
  id: string;
  parentId?: string;
  type: string;
  name: string;
  order: number;
  state: string;
  result: string;
  startTime?: string;
  finishTime?: string;
  logId?: number;
  logLineCount?: number;
  children: RelayTimelineNode[];
}

export interface RelayTimelineResponse {
  ok: true;
  buildId: number;
  cached: boolean;
  lastRefresh: string;
  timeline: RelayTimelineNode[];
}

export interface RelayTaskLogResponse {
  ok: true;
  buildId: number;
  logId: number;
  cached: boolean;
  lastRefresh: string;
  inline: boolean;
  sizeBytes: number;
  content?: string;
  downloadPath?: string;
}

export interface RelayTaskLogInfoResponse {
  ok: true;
  buildId: number;
  logId: number;
  cached: boolean;
  lastRefresh?: string;
  lineCount?: number;
  shouldDelayDownload: boolean;
}

export interface RelayArtifactSummary {
  id?: number;
  name: string;
  resourceType?: string;
  downloadUrl?: string;
  downloadedPath?: string;
}

export interface RelayArtifactsResponse {
  ok: true;
  buildId: number;
  cached: boolean;
  lastRefresh: string;
  artifacts: RelayArtifactSummary[];
}

export interface RelayArtifactDownloadResponse {
  ok: true;
  buildId: number;
  artifactName: string;
  savedPath: string;
}

export interface RelayDefinitionSummary {
  id: number;
  name: string;
  path: string;
  revision: number;
  queueStatus?: string;
  latestBuild?: {
    id?: number;
    status?: string;
    result?: string;
    finishTime?: string;
  };
}

export interface ProjectsResponse {
  ok: true;
  projects: RelayProject[];
  cached: boolean;
  lastRefresh: string;
}

export interface BuildsResponse {
  ok: true;
  projectName: string;
  builds: RelayBuildSummary[];
  cached: boolean;
  lastRefresh: string;
}

export interface BuildResponse {
  ok: true;
  build: RelayBuildDetails;
}

export interface DefinitionsResponse {
  ok: true;
  projectName: string;
  definitions: RelayDefinitionSummary[];
  cached: boolean;
  lastRefresh: string;
}

export interface DefinitionsPrecacheStatusResponse {
  ok: true;
  projectName: string;
  running: boolean;
  loadedCount: number;
  totalCount: number;
  lastRefresh?: string;
  error?: string;
}

export interface ErrorResponse {
  ok: false;
  error: string;
  code: string;
}

export interface RefreshRequest {
  resource: "projects" | "builds" | "build" | "definitions";
  orgUrl: string;
  project?: string;
  buildId?: number;
}

export interface TelemetryPayload {
  kind: "span" | "log";
  name: string;
  timestamp: string;
  traceId?: string;
  spanId?: string;
  level?: "debug" | "info" | "warn" | "error";
  attributes?: Record<string, unknown>;
}

export type RelaySubview = "definitions" | "builds" | "artifacts";
