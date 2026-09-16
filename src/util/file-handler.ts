import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { copy } from "fs-extra/esm";
import PQueue from "p-queue";
import type { IFS } from "unionfs";
import { parse as parseYaml } from "yaml";
import { isEmpty } from "./is-empty";
import { makeProgressBar } from "./make-progress-bar";

export type SavedFile = { sha256: string; size: number; mtimeMs: number; ctimeMs: number; ino: number };

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
  writtenHashes = new Map<string, { bytes: number; sha256: string }>();
  producers: Map<string, string> = new Map();
  ui: boolean;
  // Dev builds share only immutable write signatures, never mutable parsed Vaults.
  savedFiles?: Map<string, SavedFile>;
  captureRoot?: string;
  capturedFiles = new Map<string, Buffer>();
  writeStats = { written: 0, skipped: 0, skippedBytes: 0 };
  readSnapshot?: { root: string; files: Map<string, Buffer> };

  private inSnapshot(path: string) {
    return Boolean(this.readSnapshot && path.startsWith(`${this.readSnapshot.root}/`));
  }

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
    if (this.inSnapshot(this.resolve(filePath))) return this.readSnapshot!.files.has(this.resolve(filePath));
    if (this.openJsonMap.has(this.resolve(filePath))) {
      return true;
    }

    return this.fs.existsSync(this.resolve(filePath));
  }

  existsBinary(filePath: string) {
    if (this.inSnapshot(this.resolve(filePath))) return this.readSnapshot!.files.has(this.resolve(filePath));
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
    if (this.inSnapshot(filePath)) {
      const bytes = this.readSnapshot!.files.get(filePath);
      if (!bytes) throw Object.assign(new Error(`No snapshot file: ${filePath}`), { code: "ENOENT" });
      return bytes;
    }
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
    if (this.inSnapshot(filePath)) {
      const bytes = this.readSnapshot!.files.get(filePath);
      if (!bytes && allowEmpty) return {};
      if (!bytes) throw Object.assign(new Error(`No snapshot file: ${filePath}`), { code: "ENOENT" });
      return JSON.parse(bytes.toString("utf8"));
    }
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
    const resolved = this.resolve(path);
    if (this.directories.has(resolved)) return;
    await this.fs.promises.mkdir(resolved, { recursive: true });
    this.directories.add(resolved);
  }

  async remove(path: string) {
    const resolved = this.resolve(path);
    await this.fs.promises.rm(resolved, { recursive: true, force: true });
    for (const key of this.directories) {
      if (key === resolved || key.startsWith(`${resolved}/`)) this.directories.delete(key);
    }
    for (const map of [this.savedFiles, this.capturedFiles]) {
      if (map)
        for (const key of map.keys()) {
          if (key === resolved || key.startsWith(`${resolved}/`)) map.delete(key);
        }
    }
    for (const collection of [this.openJsonMap, this.openJsonChanged, this.openBinaryMap, this.openBinaryChanged]) {
      for (const key of collection.keys()) {
        if (key === resolved || key.startsWith(`${resolved}/`)) {
          collection.delete(key);
        }
      }
    }
  }

  private claim(path: string, producer?: string) {
    if (!producer) return;
    const filePath = this.resolve(path);
    const existing = this.producers.get(filePath);
    if (existing && existing !== producer) {
      throw new Error(`Output collision at ${filePath}: ${existing} conflicts with ${producer}`);
    }
    this.producers.set(filePath, producer);
  }

  clearProducerClaims() {
    this.producers.clear();
  }

  async saveJson(path: string, data: object, force = false, producer?: string) {
    this.claim(path, producer);
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
      this.openJsonChanged.set(filePath, false);
      return;
    }

    this.openJsonChanged.set(filePath, true);
  }

  /** Persist a materialized resource only when its final content changes. */
  async writeJsonIfChanged(path: string, value: object) {
    const filePath = this.resolve(path);
    const data = JSON.stringify(value);
    let previous: string | undefined;
    try {
      previous = await this.fs.promises.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (previous !== data) await this.writeFile(filePath, data);
    this.openJsonMap.set(filePath, value);
    this.openJsonChanged.set(filePath, false);
  }

  async writeFile(path: string, data: any, producer?: string) {
    this.claim(path, producer);
    const filePath = this.resolve(path);
    const digest = {
      bytes: typeof data === "string" ? Buffer.byteLength(data) : data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
    const previous = this.savedFiles?.get(filePath);
    let unchanged = false;
    if (previous?.sha256 === digest.sha256) {
      try {
        const stat = await this.fs.promises.stat(filePath);
        unchanged =
          stat.size === previous.size &&
          stat.mtimeMs === previous.mtimeMs &&
          stat.ctimeMs === previous.ctimeMs &&
          stat.ino === previous.ino;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (unchanged) {
      this.writeStats.skipped++;
      this.writeStats.skippedBytes += digest.bytes;
    } else {
      await this.mkdir(dirname(filePath));
      await this.fs.promises.writeFile(filePath, data);
      this.writeStats.written++;
      if (this.savedFiles) {
        const { size, mtimeMs, ctimeMs, ino } = await this.fs.promises.stat(filePath);
        this.savedFiles.set(filePath, { sha256: digest.sha256, size, mtimeMs, ctimeMs, ino });
      }
    }
    this.writtenFiles.add(filePath);
    this.writtenHashes.set(filePath, digest);
    if (this.captureRoot && (filePath === this.captureRoot || filePath.startsWith(`${this.captureRoot}/`))) {
      this.capturedFiles.set(filePath, Buffer.from(data));
    }
  }

  async saveAll(force = false, concurrency = 16) {
    const queue = new PQueue({ concurrency });
    const timings: Record<string, number> = {};
    let started = performance.now();

    // Open JSON
    const files = Array.from(this.openJsonMap.keys())
      .filter((k) => (force ? true : this.openJsonChanged.get(k)))
      .map((k) => [k, this.openJsonMap.get(k)] as const);

    // Open binary
    const binaryFiles = Array.from(this.openBinaryMap.keys())
      .filter((k) => (force ? true : this.openBinaryChanged.get(k)))
      .map((k) => [k, this.openBinaryMap.get(k)] as const);

    const progress = makeProgressBar(
      "Writing files",
      files.length + binaryFiles.length + this.copyTargets.length,
      this.ui
    );
    const failedToWrite: any[] = [];

    const reserved = new Map<string, string>();
    for (const filePath of [
      ...this.writtenFiles,
      ...files.map(([filePath]) => filePath),
      ...binaryFiles.map(([filePath]) => filePath),
    ]) {
      reserved.set(filePath, "generated output");
    }
    const copySources = new Map<string, string>();
    const hashableCopies = new Set<string>();
    const currentCopyTree = new Set<string>();
    const reserveCopy = (filePath: string, source: string) => {
      if (currentCopyTree.has(filePath)) return;
      const existing = reserved.get(filePath);
      if (existing) {
        throw new Error(`Output collision at ${filePath}: ${existing} conflicts with copied file ${source}`);
      }
      reserved.set(filePath, `copied file ${source}`);
      copySources.set(filePath, source);
      currentCopyTree.add(filePath);
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
        entries.map((entry) => reserveCopyTree(join(source, entry.name), join(destination, entry.name)))
      );
    };
    const virtualCopies = new Map(this.copyTargets.map(({ from }) => [from, [] as string[]]));
    for (const path of new Set([...this.openJsonMap.keys(), ...this.openBinaryMap.keys()])) {
      for (let directory = dirname(path); directory !== dirname(directory); directory = dirname(directory)) {
        virtualCopies.get(directory)?.push(path);
      }
    }
    for (const target of this.copyTargets) {
      currentCopyTree.clear();
      const virtualSources = virtualCopies.get(target.from)!;
      for (const source of virtualSources) reserveCopy(join(target.to, relative(target.from, source)), source);
      try {
        await reserveCopyTree(target.from, target.to);
      } catch (error) {
        // A directory containing only buffered files may not exist until writes finish.
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" ||
          !virtualSources.length ||
          this.fs.existsSync(target.from)
        )
          throw error;
      }
      if (target.options?.overwrite === true && Object.keys(target.options).every((key) => key === "overwrite")) {
        hashableCopies.add(target.to);
      }
    }
    timings["copy-preflight"] = performance.now() - started;
    started = performance.now();
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

    timings["writes"] = performance.now() - started;
    started = performance.now();
    // Copy chains retain serial semantics; independent targets can run together.
    if ([...copySources.values()].some((source) => copySources.has(source))) queue.concurrency = 1;
    for (const { from, to, options } of this.copyTargets) {
      queue.add(async () => {
        try {
          const json = this.openJsonMap.get(from);
          const known = this.writtenHashes.get(from);
          if (json && known && hashableCopies.has(to)) {
            const data = JSON.stringify(json, null, 2);
            if (createHash("sha256").update(data).digest("hex") === known.sha256) {
              // Buffered generated JSON can go straight to its public destination.
              await this.writeFile(to, data);
              return;
            }
          }
          await copy(from, to, options);
          for (const [destination] of copySources) {
            if (destination === to || destination.startsWith(`${to}/`)) this.writtenFiles.add(destination);
          }
          if (hashableCopies.has(to)) {
            for (const [destination, source] of copySources) {
              if (destination === to || destination.startsWith(`${to}/`)) {
                const digest = this.writtenHashes.get(source);
                if (digest) this.writtenHashes.set(destination, digest);
              }
            }
          }
        } catch (err) {
          failedToWrite.push({ filePath: to, err });
        }
      });
    }
    await queue.onIdle();
    timings["copies"] = performance.now() - started;
    progress.stop();

    // Leave failed writes queued so callers can retry without losing pending edits.
    const failedPaths = new Set(failedToWrite.map(({ filePath }) => filePath));
    this.copyTargets = this.copyTargets.filter(({ to }) => failedPaths.has(to));
    for (const changed of [this.openJsonChanged, this.openBinaryChanged]) {
      for (const path of changed.keys()) if (!failedPaths.has(path)) changed.delete(path);
    }

    return { failedToWrite, timings };
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
