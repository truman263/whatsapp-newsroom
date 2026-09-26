/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  CreateBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { S3MediaObjectStore } from "../src/modules/media-staging/s3-media-object-store";

const endpoint = process.env.ROUND8B2_S3_ENDPOINT;
if (!endpoint) throw new Error("ROUND8B2_S3_ENDPOINT required");
const bucket = process.env.ROUND8B2_S3_BUCKET ?? "proof-media";
const credentials = { accessKeyId: "proof", secretAccessKey: "proof-secret" };

function object(
  bytes: Buffer,
  mimeType: "image/png" | "image/jpeg" = "image/png",
) {
  return {
    bytes,
    size: bytes.length,
    mimeType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("Round 8B.2 real S3-compatible adapter", () => {
  const client = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials,
  });
  const store = new S3MediaObjectStore(
    {
      endpoint,
      bucket,
      region: "us-east-1",
      forcePathStyle: true,
      ...credentials,
      maxReadBytes: 1024 * 1024,
    },
    client,
  );
  const key = () => `story-media/v1/${randomUUID()}/source`;

  beforeAll(async () => {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (error: unknown) {
      if (!(
        error &&
        typeof error === "object" &&
        Reflect.get(error, "name") === "BucketAlreadyOwnedByYou"
      ))
        throw error;
    }
  });

  afterAll(() => client.destroy());

  it("persists and verifies exact metadata, bytes, and AES256 request evidence", async () => {
    const target = key();
    const media = object(Buffer.from("real-s3-exact"));
    await expect(store.putIfAbsent(target, media)).resolves.toBe("CREATED");
    await expect(store.head(target)).resolves.toEqual({
      size: media.size,
      mimeType: media.mimeType,
      sha256: media.sha256,
    });
    await expect(store.read(target)).resolves.toEqual(media.bytes);
    const remote = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: target }),
    );
    expect(remote.ServerSideEncryption).toBe("AES256");
  });

  it("converges twenty same-payload conditional writers without overwrite", async () => {
    const target = key();
    const media = object(Buffer.from("twenty-way"));
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.putIfAbsent(target, media)),
    );
    expect(results.filter((result) => result === "CREATED")).toHaveLength(1);
    expect(results.filter((result) => result === "EXISTS")).toHaveLength(19);
    await expect(store.read(target)).resolves.toEqual(media.bytes);
  });

  it("never overwrites the winner under conflicting concurrent payloads", async () => {
    const target = key();
    const candidates = Array.from({ length: 20 }, (_, index) =>
      object(
        Buffer.from(`conflict-${index}`),
        index % 2 ? "image/jpeg" : "image/png",
      ),
    );
    const results = await Promise.all(
      candidates.map((media) => store.putIfAbsent(target, media)),
    );
    expect(results.filter((result) => result === "CREATED")).toHaveLength(1);
    const stored = await store.head(target);
    const winner = candidates.find(
      (candidate) => candidate.sha256 === stored?.sha256,
    );
    expect(winner).toBeDefined();
    await expect(store.read(target)).resolves.toEqual(winner?.bytes);
  });

  it("returns null for a missing deterministic key and fails bounded reads", async () => {
    await expect(store.head(key())).resolves.toBeNull();
    const target = key();
    const media = object(Buffer.alloc(64, 1));
    await expect(store.putIfAbsent(target, media)).resolves.toBe("CREATED");
    const bounded = new S3MediaObjectStore(
      {
        endpoint,
        bucket,
        region: "us-east-1",
        forcePathStyle: true,
        ...credentials,
        maxReadBytes: 63,
      },
      client,
    );
    await expect(bounded.read(target)).rejects.toMatchObject({
      code: "MEDIA_TOO_LARGE",
    });
  });

  it("reconciles response loss after the real service persisted the object", async () => {
    const target = key();
    const media = object(Buffer.from("accepted-response-lost"));
    let lost = false;
    const responseLossClient = {
      send: async (command: unknown) => {
        const response = await client.send(command as never);
        if (command instanceof PutObjectCommand && !lost) {
          lost = true;
          throw new Error("simulated response loss after remote acceptance");
        }
        return response;
      },
    };
    const uncertainStore = new S3MediaObjectStore(
      {
        endpoint,
        bucket,
        region: "us-east-1",
        forcePathStyle: true,
        ...credentials,
        maxReadBytes: 1024 * 1024,
      },
      responseLossClient as unknown as S3Client,
    );
    await expect(uncertainStore.putIfAbsent(target, media)).resolves.toBe(
      "EXISTS",
    );
    await expect(store.read(target)).resolves.toEqual(media.bytes);
  });
});
