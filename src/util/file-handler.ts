import { dirname, join, relative } from "node:path";
import { copy } from "fs-extra/esm";
import PQueue from "p-queue";
import type { IFS } from "unionfs";
import { parse as parseYaml } from "yaml";
import { isEmpty } from "./is-empty";
import { makeProgressBar } from "./make-progress-bar";

export class FileHandler {
  fs: IFS;
  toSave: Set<string> = new Set();
  openJsonMap: Map<string, object> = new Map();
  openJsonChanged: Map<string, boolean> = new Map();
  openBinaryMap: Map<string, Buffer> = new Map();
  openBinaryChanged: Map<string, boolean> = new Map();
  directories: Set<string> = new Set();
  root: string;
  copyTargets: Array<{ from: string; to: string; options: any }> = [];
  writtenFiles: Set<string> = new Set();
  ui: boolean;

  constructor(fs: IFS, root: string, ui = false) {
    this.fs = fs;
    this.root = root;
    this.ui = ui;
  }

  dirExists(path: string) {
    return this.fs.existsSync(this.resolve(path));
  }

  dirIsEmpty(path: string) {
    const resolvePath = this.resolve(path);
    const isEmptyOnDisk = isEmpty(resolvePath);

    if (!isEmptyOnDisk) {
      return false;
    }

    const allFiles = [...Array.from(this.openJsonMap.keys()), ...Array.from(this.openBinaryMap.keys())];
    return allFiles.filter((file) => file.startsWith(resolvePath)).length === 0;
  }

  resolve(path: string) {
    let out = "";
    if (path.startsWith("/")) {
      out = join(this.root, relative(this.root, path));
    } else {
      out = join(this.root, path);
    }

    // console.log({ in: path, out, root: this.root });

    return out;
  }

  exists(filePath: string) {
    if (this.openJsonMap.has(this.resolve(filePath))) {
      return true;
    }

    return this.fs.existsSync(this.resolve(filePath));
  }

  existsBinary(filePath: string) {
    if (this.openBinaryMap.has(this.resolve(filePath))) {
      return true;
    }

    return this.fs.existsSync(this.resolve(filePath));
  }

  async loadJson(path: string, fresh = false) {
    const filePath = this.resolve(path);
    return this.openJson(filePath, true, fresh);
  }

  async copy(from: string, to: string, options: any) {
    this.copyTargets.push({ from: this.resolve(from), to: this.resolve(to), options });
  }

  async readFile(path: string) {
    const filePath = this.resolve(path);
    if (this.openBinaryMap.has(filePath)) {
      return this.openBinaryMap.get(filePath) as Buffer;
    }

    const data = await this.fs.promises.readFile(filePath);
    this.openBinaryMap.set(filePath, data);
    return data;
  }

  async readYaml(path: string) {
    const filePath = this.resolve(path);
    const data = await this.readFile(filePath);

    return parseYaml(data.toString("utf-8"));
  }

  async openJson(path: string, allowEmpty = false, fresh = false) {
    const filePath = this.resolve(path);
    if (!fresh && this.openJsonMap.has(filePath)) {
      return this.openJsonMap.get(filePath);
    }

    try {
      const data = await this.fs.promises.readFile(filePath, "utf-8");
      if (!data && allowEmpty) {
        return {};
      }

      const json = JSON.parse(data);
      this.openJsonMap.set(filePath, json);
      this.openJsonChanged.set(filePath, false);
      return json;
    } catch (err) {
      if (allowEmpty) {
        return {};
      }
      console.log("Error loading: ", filePath);
      throw err;
    }
  }

  async mkdir(path: string) {
    await this.fs.promises.mkdir(this.resolve(path), { recursive: true });
  }

  async remove(path: string) {
    const resolved = this.resolve(path);
    await this.fs.promises.rm(resolved, { recursive: true, force: true });
    for (const collection of [this.openJsonMap, this.openJsonChanged, this.openBinaryMap, this.openBinaryChanged]) {
      for (const key of collection.keys()) {
        if (key === resolved || key.startsWith(`${resolved}/`)) {
          collection.delete(key);
        }
      }
    }
  }

  async saveJson(path: string, data: object, force = false) {
    const filePath = this.resolve(path);
    const existing = this.openJsonMap.get(filePath);
    if (!existing) {
      // @todo maybe load file so we can check if we need to save it?
    } else {
      // If it does exist, we could check if its changed - although might be more compute than just saving it.
    }

    this.openJsonMap.set(filePath, data);

    if (force) {
      await this.writeFile(filePath, JSON.stringify(data, null, 2));
      return;
    }

    this.openJsonChanged.set(filePath, true);
  }

  async writeFile(path: string, data: any) {
    const filePath = this.resolve(path);
    const dirName = dirname(filePath);
    await this.fs.promises.mkdir(dirName, { recursive: true });
    await this.fs.promises.writeFile(filePath, data);
    this.writtenFiles.add(filePath);
  }

  async saveAll(force = false, concurrency = 16) {
    const queue = new PQueue({ concurrency });

    // Open JSON
    const files = Array.from(this.openJsonMap.keys())
      .filter((k) => (force ? true : this.openJsonChanged.get(k)))
      .map((k) => [k, this.openJsonMap.get(k)] as const);

    // Open binary
    const binaryFiles = Array.from(this.openBinaryMap.keys())
      .filter((k) => (force ? true : this.openBinaryChanged.get(k)))
      .map((k) => [k, this.openBinaryMap.get(k)] as const);

    const progress = makeProgressBar("Writing files", files.length + binaryFiles.length, this.ui);
    const failedToWrite: any[] = [];

    const reserved = new Map<string, string>();
    for (const filePath of [...this.writtenFiles, ...files.map(([filePath]) => filePath), ...binaryFiles.map(([filePath]) => filePath)]) {
      reserved.set(filePath, "generated output");
    }
    const reserveCopy = (filePath: string, source: string) => {
      const existing = reserved.get(filePath);
      if (existing) {
        throw new Error(`Output collision at ${filePath}: ${existing} conflicts with copied file ${source}`);
      }
      reserved.set(filePath, `copied file ${source}`);
    };
    const reserveCopyTree = async (source: string, destination: string) => {
      const virtualFile = this.openJsonMap.has(source) || this.openBinaryMap.has(source);
      if (virtualFile) {
        reserveCopy(destination, source);
        return;
      }
      const stat = await this.fs.promises.stat(source);
      if (!stat.isDirectory()) {
        reserveCopy(destination, source);
        return;
      }
      const entries = await this.fs.promises.readdir(source, { withFileTypes: true });
      await Promise.all(
        entries.map((entry) =>
          reserveCopyTree(join(source, entry.name), join(destination, entry.name))
        )
      );
    };
    for (const target of this.copyTargets) {
      await reserveCopyTree(target.from, target.to);
    }
    for (const [filePath, data] of files) {
      queue.add(
        async () =>
          await this.writeFile(filePath, JSON.stringify(data, null, 2)).catch((err) =>
            failedToWrite.push({ filePath, err })
          )
      );
    }

    for (const [filePath, data] of binaryFiles) {
      queue.add(async () => await this.writeFile(filePath, data).catch((err) => failedToWrite.push({ filePath, err })));
    }

    queue.on("completed", () => progress.increment());

    await queue.onIdle();

    // Copy fields.
    for (const { from, to, options } of this.copyTargets) {
      await copy(from, to, options).catch((err) => failedToWrite.push({ filePath: to, err }));
    }

    progress.stop();

    // Clear all copy targets.
    this.copyTargets.length = 0;
    this.openJsonChanged.clear();
    this.openBinaryChanged.clear();

    return { failedToWrite };
  }

  async cachePathExists(to: string) {
    try {
      await this.fs.promises.stat(this.resolve(to));
      return true;
    } catch (e) {
      return false;
    }
  }
}
