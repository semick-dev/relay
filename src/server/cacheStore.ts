import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { RelayStorage } from "./storage";

export interface CacheEntry<T> {
  body: T;
  cached: boolean;
  lastRefresh: string;
}

interface CacheRecord {
  key: string;
  method: string;
  url: string;
  contentType: string;
  statusCode: number;
  timestamp: string;
  ttlSeconds: number;
  bodyPath: string;
}

export class RelayCacheStore {
  constructor(private readonly storage: RelayStorage) {}

  normalizeUrl(rawUrl: string): string {
    const parsed = new URL(rawUrl);
    parsed.hostname = parsed.hostname.toLowerCase();
    const sorted = [...parsed.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) => {
      if (aKey === bKey) {
        return aValue.localeCompare(bValue);
      }
      return aKey.localeCompare(bKey);
    });
    parsed.search = "";
    for (const [key, value] of sorted) {
      if (value.length > 0) {
        parsed.searchParams.append(key, value);
      }
    }
    return parsed.toString();
  }

  buildKey(method: string, rawUrl: string): string {
    const normalized = this.normalizeUrl(rawUrl);
    return `${method.toUpperCase()} ${normalized}`;
  }

  async readJson<T>(method: string, rawUrl: string): Promise<CacheEntry<T> | null> {
    const key = this.buildKey(method, rawUrl);
    const record = await this.readRecord(key);
    if (!record) {
      return null;
    }

    const body = await fs.readFile(record.bodyPath, "utf8");
    return {
      body: JSON.parse(body) as T,
      cached: true,
      lastRefresh: record.timestamp
    };
  }

  async isFresh(method: string, rawUrl: string): Promise<boolean> {
    const key = this.buildKey(method, rawUrl);
    const record = await this.readRecord(key);
    if (!record) {
      return false;
    }

    const expiresAt = new Date(record.timestamp).getTime() + record.ttlSeconds * 1000;
    return Date.now() < expiresAt;
  }

  async writeJson<T>(method: string, rawUrl: string, ttlSeconds: number, body: T): Promise<CacheEntry<T>> {
    const normalizedUrl = this.normalizeUrl(rawUrl);
    const key = `${method.toUpperCase()} ${normalizedUrl}`;
    const digest = crypto.createHash("sha256").update(key).digest("hex");
    const metadataPath = path.join(this.storage.cacheDir, `${digest}.json`);
    const bodyPath = path.join(this.storage.cacheDir, `${digest}.body.json`);
    const timestamp = new Date().toISOString();
    const record: CacheRecord = {
      key,
      method: method.toUpperCase(),
      url: normalizedUrl,
      contentType: "application/json",
      statusCode: 200,
      timestamp,
      ttlSeconds,
      bodyPath
    };

    await fs.writeFile(bodyPath, JSON.stringify(body, null, 2), "utf8");
    await fs.writeFile(metadataPath, JSON.stringify(record, null, 2), "utf8");

    return {
      body,
      cached: false,
      lastRefresh: timestamp
    };
  }

  private async readRecord(key: string): Promise<CacheRecord | null> {
    const digest = crypto.createHash("sha256").update(key).digest("hex");
    const metadataPath = path.join(this.storage.cacheDir, `${digest}.json`);

    try {
      const raw = await fs.readFile(metadataPath, "utf8");
      return JSON.parse(raw) as CacheRecord;
    } catch {
      return null;
    }
  }
}
