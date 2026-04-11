import * as fs from "fs/promises";
import * as path from "path";

export class RelayStorage {
  readonly rootDir: string;
  readonly cacheDir: string;
  readonly buildDir: string;

  constructor(globalStoragePath: string) {
    this.rootDir = path.join(globalStoragePath, ".relay");
    this.cacheDir = path.join(this.rootDir, "cache");
    this.buildDir = path.join(this.rootDir, "build");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    await fs.mkdir(this.buildDir, { recursive: true });
  }

  async ensureBuildDir(buildId: number): Promise<string> {
    const target = path.join(this.buildDir, String(buildId));
    await fs.mkdir(target, { recursive: true });
    return target;
  }

  async writeBuildTimestamp(buildId: number, timestamp: string): Promise<void> {
    const target = await this.ensureBuildDir(buildId);
    await fs.writeFile(path.join(target, "timestamp"), `${timestamp}\n`, "utf8");
  }

  async readBuildTimestamp(buildId: number): Promise<string | null> {
    try {
      const target = await this.ensureBuildDir(buildId);
      const raw = await fs.readFile(path.join(target, "timestamp"), "utf8");
      return raw.trim() || null;
    } catch {
      return null;
    }
  }

  async writeBuildJson(buildId: number, fileName: string, value: unknown): Promise<void> {
    const target = await this.ensureBuildDir(buildId);
    await fs.writeFile(path.join(target, fileName), JSON.stringify(value, null, 2), "utf8");
  }

  async readBuildJson<T>(buildId: number, fileName: string): Promise<T | null> {
    try {
      const target = await this.ensureBuildDir(buildId);
      const raw = await fs.readFile(path.join(target, fileName), "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async writeBuildText(buildId: number, relativePath: string, content: string): Promise<void> {
    const target = await this.ensureBuildDir(buildId);
    const filePath = path.join(target, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }

  async readBuildText(buildId: number, relativePath: string): Promise<string | null> {
    try {
      const target = await this.ensureBuildDir(buildId);
      return await fs.readFile(path.join(target, relativePath), "utf8");
    } catch {
      return null;
    }
  }

  async hasBuildFile(buildId: number, relativePath: string): Promise<boolean> {
    try {
      const target = await this.ensureBuildDir(buildId);
      await fs.stat(path.join(target, relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async getBuildFileSize(buildId: number, relativePath: string): Promise<number | null> {
    try {
      const target = await this.ensureBuildDir(buildId);
      const stat = await fs.stat(path.join(target, relativePath));
      return stat.size;
    } catch {
      return null;
    }
  }

  getBuildFilePath(buildId: number, relativePath: string): string {
    return path.join(this.buildDir, String(buildId), relativePath);
  }

  async writeFileBytes(filePath: string, content: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }

  async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
