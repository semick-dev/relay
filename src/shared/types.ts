export type LayoutMode = "main" | "split";

export type ThemeId = "neon" | "nightwave" | "ember";

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
  definitionName: string;
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

export interface ErrorResponse {
  ok: false;
  error: string;
  code: string;
}

export interface RefreshRequest {
  resource: "projects" | "builds" | "build";
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
