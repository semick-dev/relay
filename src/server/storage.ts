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
}
