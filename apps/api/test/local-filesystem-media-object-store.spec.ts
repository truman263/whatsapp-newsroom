import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyStagedObject } from "../src/modules/media-staging/media-staging.service";
import { UnconfiguredMediaObjectStore } from "../src/modules/media-staging/unconfigured-media-object-store";
import {
  mediaObjectKey,
  type DownloadedMedia,
  type MediaObjectStore,
  type StoredObjectHead,
} from "../src/modules/media-staging/media-staging.types";
import { LocalFilesystemMediaObjectStore } from "./support/local-filesystem-media-object-store";

function fixture(bytes = Buffer.from("durable")): DownloadedMedia {
  return {
    bytes,
    mimeType: "image/jpeg" as const,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("test-only filesystem media object store", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "newsroom-media-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("conditionally writes and durably reads the deterministic object", async () => {
    const store = new LocalFilesystemMediaObjectStore(root);
    const media = fixture();
    const key = `story-media/v1/${randomUUID()}/source`;
    await expect(store.putIfAbsent(key, media)).resolves.toBe("CREATED");
    await expect(store.putIfAbsent(key, media)).resolves.toBe("EXISTS");
    await expect(store.head(key)).resolves.toEqual({
      size: media.size,
      sha256: media.sha256,
      mimeType: media.mimeType,
    });
    await expect(store.read(key)).resolves.toEqual(media.bytes);
  });

  it("rejects traversal, absolute, and alternate-separator keys", async () => {
    const store = new LocalFilesystemMediaObjectStore(root);
    await expect(store.read("../escape")).rejects.toThrow("INVALID_OBJECT_KEY");
    await expect(store.read("C:\\escape")).rejects.toThrow("INVALID_OBJECT_KEY");
    await expect(store.read("/etc/passwd")).rejects.toThrow("INVALID_OBJECT_KEY");
    await expect(store.read("C:/escape")).rejects.toThrow("INVALID_OBJECT_KEY");
    await expect(
      store.read("story-media\\v1\\escape"),
    ).rejects.toThrow("INVALID_OBJECT_KEY");
    await expect(
      store.read("story-media/v1/../escape/source"),
    ).rejects.toThrow("INVALID_OBJECT_KEY");
    const id = randomUUID();
    await symlink(
      tmpdir(),
      join(root, "story-media"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const media = fixture(Buffer.from("x"));
    await expect(
      store.putIfAbsent(`story-media/v1/${id}/source`, media),
    ).rejects.toThrow();
    await expect(store.head(`story-media/v1/${id}/source`)).rejects.toThrow(
      "UNSAFE_OBJECT_PATH",
    );
    await expect(store.read(`story-media/v1/${id}/source`)).rejects.toThrow(
      "UNSAFE_OBJECT_PATH",
    );
  });

  it("uses only the exact UUID deterministic key", () => {
    const id = "01234567-89ab-4def-8abc-0123456789ab";
    expect(mediaObjectKey(id)).toBe(`story-media/v1/${id}/source`);
    expect(() => mediaObjectKey("provider-media-id")).toThrow("INVALID_MEDIA_ID");
  });

  it("reuses matching objects, preserves mismatching objects, and verifies exact evidence", async () => {
    const store = new LocalFilesystemMediaObjectStore(root);
    const key = mediaObjectKey(randomUUID());
    const original = fixture(Buffer.from("first durable object"));
    const replacement = fixture(Buffer.from("different bytes"));
    await store.putIfAbsent(key, original);
    await expect(store.putIfAbsent(key, replacement)).resolves.toBe("EXISTS");
    await expect(verifyStagedObject(store, key, original.mimeType)).resolves.toEqual({
      size: original.size,
      sha256: original.sha256,
      mimeType: original.mimeType,
    });
    await expect(verifyStagedObject(store, key, replacement.mimeType)).resolves.toEqual({
      size: original.size,
      sha256: original.sha256,
      mimeType: original.mimeType,
    });
    expect(await store.read(key)).toEqual(original.bytes);
  });

  it("fails closed and remains idempotent when durable evidence is mismatched", async () => {
    const store = new LocalFilesystemMediaObjectStore(root);
    const key = mediaObjectKey(randomUUID());
    const media = fixture();
    await store.putIfAbsent(key, media);
    await expect(verifyStagedObject(store, key, "image/png")).rejects.toMatchObject({
      code: "MEDIA_OBJECT_CONFLICT",
    });
    await expect(verifyStagedObject(store, key, "image/png")).rejects.toMatchObject({
      code: "MEDIA_OBJECT_CONFLICT",
    });
    expect(await store.read(key)).toEqual(media.bytes);
  });

  it("detects durable bytes changed after the atomic write", async () => {
    const store = new LocalFilesystemMediaObjectStore(root);
    const key = mediaObjectKey(randomUUID());
    const media = fixture();
    await store.putIfAbsent(key, media);
    await writeFile(join(root, ...key.split("/")), Buffer.from("tampered"));
    await expect(verifyStagedObject(store, key, media.mimeType)).rejects.toMatchObject({
      code: "MEDIA_OBJECT_CONFLICT",
    });
  });

  it("reports a missing object as null and leaves no temporary write residue", async () => {
    const store = new LocalFilesystemMediaObjectStore(root);
    const key = mediaObjectKey(randomUUID());
    await expect(store.head(key)).resolves.toBeNull();
    await store.putIfAbsent(key, fixture());
    const residue: string[] = [];
    const examine = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const child = join(directory, entry.name);
        if (entry.isDirectory()) await examine(child);
        else residue.push(child);
      }
    };
    await examine(root);
    expect(residue.some((path) => path.endsWith(".tmp"))).toBe(false);
  });

  it("never follows a pre-existing symlink at the object file path outside the root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "newsroom-outside-"));
    try {
      const sentinel = Buffer.from("outside-secret-must-not-leak");
      const secretFile = join(outside, "secret.bin");
      await writeFile(secretFile, sentinel);
      const key = mediaObjectKey(randomUUID());
      const linkPath = join(root, ...key.split("/"));
      await mkdir(dirname(linkPath), { recursive: true });
      try {
        await symlink(secretFile, linkPath, "file");
      } catch {
        await symlink(
          outside,
          linkPath,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      const store = new LocalFilesystemMediaObjectStore(root);
      await expect(store.read(key)).rejects.toThrow("UNSAFE_OBJECT_PATH");
      await expect(store.head(key)).rejects.toThrow("UNSAFE_OBJECT_PATH");
      await expect(
        store.putIfAbsent(key, fixture(Buffer.from("x"))),
      ).resolves.toBe("EXISTS");
      expect(await readFile(secretFile)).toEqual(sentinel);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps ambiguous-write evidence available for later verification without overwrite", async () => {
    const media = fixture(Buffer.from("durable before error"));
    const key = mediaObjectKey(randomUUID());
    const objects = new Map<string, DownloadedMedia>();
    const ambiguous: MediaObjectStore = {
      putIfAbsent(objectKey, object) {
        objects.set(objectKey, object);
        return Promise.reject(new Error("ambiguous transport outcome"));
      },
      head(objectKey): Promise<StoredObjectHead | null> {
        const object = objects.get(objectKey);
        return Promise.resolve(
          object
            ? {
                size: object.size,
                sha256: object.sha256,
                mimeType: object.mimeType,
              }
            : null,
        );
      },
      read(objectKey) {
        const object = objects.get(objectKey);
        return object
          ? Promise.resolve(object.bytes)
          : Promise.reject(new Error("missing object"));
      },
    };
    await expect(ambiguous.putIfAbsent(key, media)).rejects.toThrow("ambiguous");
    await expect(verifyStagedObject(ambiguous, key, media.mimeType)).resolves.toEqual({
      size: media.size,
      sha256: media.sha256,
      mimeType: media.mimeType,
    });
    expect(await ambiguous.read(key)).toEqual(media.bytes);
  });

  it("fails closed when no production object store is configured", async () => {
    const store = new UnconfiguredMediaObjectStore();
    const media = fixture();
    const key = mediaObjectKey(randomUUID());
    await expect(store.putIfAbsent(key, media)).rejects.toMatchObject({
      code: "MEDIA_OBJECT_UNAVAILABLE",
    });
    await expect(store.head(key)).rejects.toMatchObject({
      code: "MEDIA_OBJECT_UNAVAILABLE",
    });
    await expect(store.read(key)).rejects.toMatchObject({
      code: "MEDIA_OBJECT_UNAVAILABLE",
    });
  });
});
