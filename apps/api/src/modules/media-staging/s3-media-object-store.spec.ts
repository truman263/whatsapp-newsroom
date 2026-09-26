import { createHash } from "node:crypto";
import { Readable } from "node:stream";
/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await */
import {
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { MediaStagingError } from "./media-staging.errors";
import { S3MediaObjectStore } from "./s3-media-object-store";

const key = "story-media/v1/123e4567-e89b-42d3-a456-426614174000/source";
const bytes = Buffer.from("verified-image");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const media = {
  bytes,
  size: bytes.length,
  sha256,
  mimeType: "image/png" as const,
};

function store(
  send: (command: unknown) => Promise<unknown>,
  maxReadBytes = 100,
) {
  return new S3MediaObjectStore(
    {
      bucket: "proof-media",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:4566",
      forcePathStyle: true,
      accessKeyId: "proof",
      secretAccessKey: "proof",
      maxReadBytes,
    },
    { send } as unknown as S3Client,
  );
}

describe("S3MediaObjectStore", () => {
  it("constructs an atomic encrypted conditional write with exact metadata", async () => {
    let input: PutObjectCommand["input"] | undefined;
    const subject = store(async (command) => {
      expect(command).toBeInstanceOf(PutObjectCommand);
      input = (command as PutObjectCommand).input;
      return {};
    });
    await expect(subject.putIfAbsent(key, media)).resolves.toBe("CREATED");
    expect(input).toMatchObject({
      Bucket: "proof-media",
      Key: key,
      ContentLength: bytes.length,
      ContentType: "image/png",
      Metadata: { sha256 },
      ServerSideEncryption: "AES256",
      IfNoneMatch: "*",
    });
  });

  it("reconciles an uncertain conditional write by HEAD", async () => {
    const subject = store(async (command) => {
      if (command instanceof PutObjectCommand) throw new Error("transport");
      expect(command).toBeInstanceOf(HeadObjectCommand);
      return {
        ContentLength: bytes.length,
        ContentType: "image/png",
        Metadata: { sha256 },
      };
    });
    await expect(subject.putIfAbsent(key, media)).resolves.toBe("EXISTS");
  });

  it.each([
    "",
    "../x",
    "story-media/v1/not-a-uuid/source",
    `${key}/extra`,
    "https://bucket.test/key",
    "story-media/v1/%2e%2e/source",
  ])("rejects non-canonical key %p before I/O", async (invalid) => {
    const send = jest.fn();
    await expect(store(send).head(invalid)).rejects.toMatchObject({
      code: "MEDIA_OBJECT_CONFLICT",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("verifies metadata, stream length, byte digest, and configured bound", async () => {
    const subject = store(async (command) =>
      command instanceof HeadObjectCommand
        ? {
            ContentLength: bytes.length,
            ContentType: "image/png",
            Metadata: { sha256 },
          }
        : { ContentLength: bytes.length, Body: Readable.from([bytes]) },
    );
    await expect(subject.read(key)).resolves.toEqual(bytes);
    await expect(
      store(
        async () => ({
          ContentLength: bytes.length,
          ContentType: "image/png",
          Metadata: { sha256 },
        }),
        bytes.length - 1,
      ).read(key),
    ).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
  });

  it("rejects malformed metadata and mismatched upload bytes", async () => {
    await expect(
      store(async () => ({
        ContentLength: bytes.length,
        ContentType: "text/plain",
        Metadata: {},
      })).head(key),
    ).rejects.toBeInstanceOf(MediaStagingError);
    await expect(
      store(jest.fn()).putIfAbsent(key, { ...media, sha256: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "MEDIA_OBJECT_CONFLICT" });
  });
});
