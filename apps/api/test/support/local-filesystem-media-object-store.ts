import {
  link,
  mkdir,
  lstat,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  DownloadedMedia,
  MediaObjectStore,
  StoredObjectHead,
} from "../../src/modules/media-staging/media-staging.types";

export class LocalFilesystemMediaObjectStore implements MediaObjectStore {
  private readonly absoluteRoot: string;
  constructor(root: string) {
    this.absoluteRoot = resolve(root);
  }

  async putIfAbsent(
    key: string,
    media: DownloadedMedia,
  ): Promise<"CREATED" | "EXISTS"> {
    const target = this.target(key);
    await this.safeParents(dirname(target), true);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(media.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const created = await link(temporary, target)
        .then(() => true)
        .catch((error: NodeJS.ErrnoException) =>
          error.code === "EEXIST" ? false : Promise.reject(error),
        );
      if (!created) return "EXISTS";
      await writeFile(
        `${target}.metadata`,
        JSON.stringify({
          size: media.size,
          sha256: media.sha256,
          mimeType: media.mimeType,
        }),
        { flag: "wx", mode: 0o600 },
      );
      return "CREATED";
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    const target = this.target(key);
    if (!(await this.safeParents(dirname(target), false))) return null;
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("UNSAFE_OBJECT_PATH");
      const parsed = JSON.parse(
        await readFile(`${target}.metadata`, "utf8"),
      ) as StoredObjectHead;
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async read(key: string): Promise<Buffer> {
    const target = this.target(key);
    await this.safeParents(dirname(target), false);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("UNSAFE_OBJECT_PATH");
    return readFile(target);
  }

  private target(key: string): string {
    if (
      !/^story-media\/v1\/[0-9a-f-]{36}\/source$/iu.test(key) ||
      isAbsolute(key) ||
      key.includes("..") ||
      key.includes("\\")
    )
      throw new Error("INVALID_OBJECT_KEY");
    const target = resolve(join(this.absoluteRoot, ...key.split("/")));
    const rel = relative(this.absoluteRoot, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw new Error("INVALID_OBJECT_KEY");
    return target;
  }

  private async safeParents(
    directory: string,
    createMissing: boolean,
  ): Promise<boolean> {
    const root = await lstat(this.absoluteRoot);
    if (root.isSymbolicLink() || !root.isDirectory())
      throw new Error("UNSAFE_OBJECT_PATH");
    const relativeDirectory = relative(this.absoluteRoot, directory);
    const parts = relativeDirectory ? relativeDirectory.split(/[\\/]/u) : [];
    let current = this.absoluteRoot;
    for (const part of parts) {
      current = join(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory())
          throw new Error("UNSAFE_OBJECT_PATH");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!createMissing) return false;
        await mkdir(current, { mode: 0o700 });
      }
    }
    return true;
  }
}
