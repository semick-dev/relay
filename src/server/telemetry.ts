import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { TelemetryPayload } from "../shared/types";

interface SpanContext {
  traceId: string;
  spanId: string;
}

export class RelayTelemetrySink {
  private readonly sessionId = crypto.randomUUID();
  private readonly folder = process.env.RELAY_OTEL_FOLDER;
  private ready: Promise<void>;

  constructor() {
    this.ready = this.init();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  createSpanContext(): SpanContext {
    return {
      traceId: crypto.randomBytes(16).toString("hex"),
      spanId: crypto.randomBytes(8).toString("hex")
    };
  }

  async span(name: string, attributes: Record<string, unknown> = {}, parent?: Partial<SpanContext>): Promise<SpanContext> {
    const context = {
      traceId: parent?.traceId ?? crypto.randomBytes(16).toString("hex"),
      spanId: crypto.randomBytes(8).toString("hex")
    };
    await this.write({
      kind: "span",
      name,
      timestamp: new Date().toISOString(),
      traceId: context.traceId,
      spanId: context.spanId,
      attributes
    });
    return context;
  }

  async log(
    name: string,
    level: "debug" | "info" | "warn" | "error",
    attributes: Record<string, unknown> = {},
    parent?: Partial<SpanContext>
  ): Promise<void> {
    await this.write({
      kind: "log",
      name,
      level,
      timestamp: new Date().toISOString(),
      traceId: parent?.traceId,
      spanId: parent?.spanId,
      attributes
    });
  }

  async ingest(payload: TelemetryPayload): Promise<void> {
    await this.write(payload);
  }

  private async init(): Promise<void> {
    if (!this.folder) {
      return;
    }

    await fs.mkdir(path.join(this.folder, this.sessionId), { recursive: true });
  }

  private async write(payload: TelemetryPayload): Promise<void> {
    await this.ready;
    const serialized = `${JSON.stringify(payload)}\n`;

    if (!this.folder) {
      process.stdout.write(serialized);
      return;
    }

    const suffix = payload.kind === "span" ? "traces.ndjson" : "logs.ndjson";
    const filePath = path.join(this.folder, this.sessionId, suffix);
    await fs.appendFile(filePath, serialized, "utf8");
  }
}
