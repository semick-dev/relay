import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  INLINE_TASK_LOG_LIMIT_BYTES,
  RelayApiServer,
  resolveTaskLogProbeDecision,
  shouldDelayTaskLogDownload
} from "../src/server/apiServer";

function createServer() {
  const adoClient = {
    getLog: vi.fn(),
    getLogSize: vi.fn()
  };
  const storage = {
    readBuildTimestamp: vi.fn().mockResolvedValue(null),
    readBuildText: vi.fn().mockResolvedValue(null),
    writeBuildTimestamp: vi.fn().mockResolvedValue(undefined),
    writeBuildText: vi.fn().mockResolvedValue(undefined),
    hasBuildFile: vi.fn().mockResolvedValue(false),
    getBuildFileSize: vi.fn().mockResolvedValue(null),
    getBuildFilePath: vi.fn((buildId: number, relativePath: string) => `/tmp/build/${buildId}/${relativePath}`)
  };
  const telemetry = {
    span: vi.fn(),
    log: vi.fn(),
    ingest: vi.fn()
  };
  const server = new RelayApiServer(adoClient as any, {} as any, storage as any, telemetry as any);
  vi.spyOn(server as any, "loadBuild").mockResolvedValue({
    build: {
      id: 77,
      buildNumber: "2026.04.18.1",
      definitionName: "demo",
      projectName: "proj",
      status: "completed",
      result: "succeeded",
      finishTime: "2026-04-18T00:00:00.000Z",
      lastRefresh: "2026-04-18T00:00:00.000Z",
      cached: false
    }
  });
  vi.spyOn(server as any, "loadTimeline").mockResolvedValue({
    timeline: [{
      id: "node-1",
      type: "Task",
      name: "Task 1",
      order: 1,
      state: "completed",
      result: "succeeded",
      logId: 9,
      logLineCount: 123,
      children: []
    }]
  });
  return { adoClient, storage, server };
}

describe("task log probe helpers", () => {
  it("delays download when the probe fills the full 50KB window without a known total size", () => {
    expect(resolveTaskLogProbeDecision({
      contentBytes: INLINE_TASK_LOG_LIMIT_BYTES
    })).toEqual({
      sizeBytes: INLINE_TASK_LOG_LIMIT_BYTES,
      shouldDelayDownload: true
    });
  });

  it("treats exactly 50KB as inline when the real size is known", () => {
    expect(shouldDelayTaskLogDownload(INLINE_TASK_LOG_LIMIT_BYTES, 0)).toBe(false);
    expect(resolveTaskLogProbeDecision({
      contentBytes: INLINE_TASK_LOG_LIMIT_BYTES,
      totalSize: INLINE_TASK_LOG_LIMIT_BYTES
    })).toEqual({
      sizeBytes: INLINE_TASK_LOG_LIMIT_BYTES,
      shouldDelayDownload: false
    });
  });
});

describe("RelayApiServer task log loading", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("keeps a long log in delayed-download mode after the initial probe", async () => {
    const { adoClient, storage, server } = createServer();
    adoClient.getLog.mockResolvedValue({
      content: "x".repeat(INLINE_TASK_LOG_LIMIT_BYTES),
      contentBytes: INLINE_TASK_LOG_LIMIT_BYTES
    });

    const response = await (server as any).loadTaskLog("https://dev.azure.com/org", "proj", 77, 9, false);

    expect(adoClient.getLog).toHaveBeenCalledWith("https://dev.azure.com/org", "proj", 77, 9, {
      startByte: 0,
      endByte: INLINE_TASK_LOG_LIMIT_BYTES - 1
    });
    expect(response).toMatchObject({
      ok: true,
      buildId: 77,
      logId: 9,
      cached: false,
      inline: false,
      sizeBytes: INLINE_TASK_LOG_LIMIT_BYTES
    });
    expect(storage.writeBuildText).not.toHaveBeenCalled();
  });

  it("writes and returns small logs inline after the probe", async () => {
    const { adoClient, storage, server } = createServer();
    adoClient.getLog.mockResolvedValue({
      content: "small log",
      contentBytes: 9
    });

    const response = await (server as any).loadTaskLog("https://dev.azure.com/org", "proj", 77, 9, false);

    expect(response).toMatchObject({
      ok: true,
      buildId: 77,
      logId: 9,
      cached: false,
      inline: true,
      sizeBytes: 9,
      content: "small log"
    });
    expect(storage.writeBuildText).toHaveBeenCalledWith(77, "logs/9.txt", "small log");
  });

  it("downloads and persists the full log only after an explicit refresh click", async () => {
    const { adoClient, storage, server } = createServer();
    adoClient.getLog.mockResolvedValue({
      content: "y".repeat(INLINE_TASK_LOG_LIMIT_BYTES + 25),
      contentBytes: INLINE_TASK_LOG_LIMIT_BYTES + 25,
      totalSize: INLINE_TASK_LOG_LIMIT_BYTES + 25
    });

    const response = await (server as any).loadTaskLog("https://dev.azure.com/org", "proj", 77, 9, true);

    expect(adoClient.getLog).toHaveBeenCalledWith("https://dev.azure.com/org", "proj", 77, 9);
    expect(response).toMatchObject({
      ok: true,
      buildId: 77,
      logId: 9,
      cached: false,
      inline: false,
      sizeBytes: INLINE_TASK_LOG_LIMIT_BYTES + 25,
      downloadPath: "/tmp/build/77/logs/9.txt"
    });
    expect(storage.writeBuildText).toHaveBeenCalledWith(77, "logs/9.txt", "y".repeat(INLINE_TASK_LOG_LIMIT_BYTES + 25));
  });

  it("marks cached files over 50KB as delayed downloads in task log metadata", async () => {
    const { adoClient, storage, server } = createServer();
    storage.hasBuildFile.mockResolvedValue(true);
    storage.getBuildFileSize.mockResolvedValue(INLINE_TASK_LOG_LIMIT_BYTES + 5);
    storage.readBuildTimestamp.mockResolvedValue("2026-04-18T00:00:01.000Z");

    const response = await (server as any).getTaskLogInfo("https://dev.azure.com/org", "proj", 77, 9, false);

    expect(adoClient.getLogSize).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      ok: true,
      buildId: 77,
      logId: 9,
      cached: true,
      sizeBytes: INLINE_TASK_LOG_LIMIT_BYTES + 5,
      downloadPath: "/tmp/build/77/logs/9.txt",
      isLarge: true,
      shouldDelayDownload: true
    });
  });
});

describe("RelayApiServer build list loading", () => {
  it("forwards batch size and continuation token to the ADO build list call", async () => {
    const adoClient = {
      listBuilds: vi.fn().mockResolvedValue({
        builds: [{
          id: 480,
          buildNumber: "20260419.2",
          definitionName: "demo",
          status: "completed",
          result: "succeeded"
        }],
        continuationToken: "next-page"
      }),
      getBuildChanges: vi.fn().mockResolvedValue("commit")
    };
    const cacheStore = {
      isFresh: vi.fn().mockResolvedValue(false),
      writeJson: vi.fn(async (_method: string, _url: string, _ttl: number, body: unknown) => ({
        body,
        cached: false,
        lastRefresh: "2026-04-18T00:00:00.000Z"
      }))
    };
    const storage = {
      ensureReady: vi.fn(),
      writeBuildTimestamp: vi.fn()
    };
    const telemetry = {
      span: vi.fn(),
      log: vi.fn(),
      ingest: vi.fn()
    };
    const server = new RelayApiServer(adoClient as any, cacheStore as any, storage as any, telemetry as any);

    const response = await (server as any).loadBuilds("https://dev.azure.com/org", "proj", false, 12, 25, "cursor-1");

    expect(adoClient.listBuilds).toHaveBeenCalledWith("https://dev.azure.com/org", "proj", 25, 12, "cursor-1");
    expect(adoClient.getBuildChanges).toHaveBeenCalledWith("https://dev.azure.com/org", "proj", 480);
    expect(response).toMatchObject({
      ok: true,
      projectName: "proj",
      continuationToken: "next-page",
      builds: [{
        id: 480,
        commitMessage: "commit"
      }]
    });
  });
});

describe("RelayApiServer build cancellation", () => {
  it("deduplicates build ids before forwarding cancellation requests", async () => {
    const adoClient = {
      cancelBuilds: vi.fn().mockResolvedValue([480, 481])
    };
    const telemetry = {
      span: vi.fn(),
      log: vi.fn(),
      ingest: vi.fn()
    };
    const server = new RelayApiServer(adoClient as any, {} as any, {} as any, telemetry as any);

    const response = await (server as any).cancelBuilds("https://dev.azure.com/org", "proj", [480, 480, 481, -1]);

    expect(adoClient.cancelBuilds).toHaveBeenCalledWith("https://dev.azure.com/org", "proj", [480, 481]);
    expect(response).toEqual({
      ok: true,
      cancelledIds: [480, 481]
    });
  });
});
