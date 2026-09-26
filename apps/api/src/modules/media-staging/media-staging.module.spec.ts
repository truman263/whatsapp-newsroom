import "reflect-metadata";
import {
  MEDIA_OBJECT_STORE,
  MEDIA_PROVIDER_CLIENT,
} from "./media-staging.types";
import { MediaStagingService } from "./media-staging.service";
import {
  HttpsPinnedTransport,
  MetaMediaClient,
  SystemMetaResolver,
} from "./meta-media.client";
import { UnconfiguredMediaObjectStore } from "./unconfigured-media-object-store";
import { MediaStagingModule } from "./media-staging.module";
import { MediaStagingError } from "./media-staging.errors";
import { S3MediaObjectStore } from "./s3-media-object-store";

type ObjectStoreProvider = {
  provide: symbol;
  useFactory: (config: {
    get: (key: string) => Record<string, unknown> | number;
  }) => unknown;
};

function objectStoreProvider(): ObjectStoreProvider {
  const providers = Reflect.getMetadata(
    "providers",
    MediaStagingModule,
  ) as Array<unknown>;
  const registrations = providers.filter(
    (provider): provider is ObjectStoreProvider =>
      !!provider &&
      typeof provider === "object" &&
      "provide" in provider &&
      provider.provide === MEDIA_OBJECT_STORE,
  );
  expect(registrations).toHaveLength(1);
  return registrations[0]!;
}

describe("MediaStagingModule wiring", () => {
  it("registers one configuration-driven object store provider and fails closed", () => {
    const providers = Reflect.getMetadata(
      "providers",
      MediaStagingModule,
    ) as Array<unknown>;
    expect(providers).toBeDefined();
    expect(providers).toContain(UnconfiguredMediaObjectStore);
    expect(providers).toEqual(
      expect.arrayContaining([
        { provide: MEDIA_PROVIDER_CLIENT, useExisting: MetaMediaClient },
      ]),
    );
    const registration = objectStoreProvider();
    const config = (
      mediaObjectStore: Record<string, unknown>,
    ): { get: (key: string) => Record<string, unknown> | number } => ({
      get: (key: string): Record<string, unknown> | number =>
        key === "mediaObjectStore" ? mediaObjectStore : 1024,
    });
    expect(
      registration.useFactory(config({ driver: "unconfigured" })),
    ).toBeInstanceOf(UnconfiguredMediaObjectStore);
    expect(
      registration.useFactory(
        config({
          driver: "s3",
          bucket: "proof-media",
          region: "us-east-1",
          forcePathStyle: true,
          accessKeyId: "proof",
          secretAccessKey: "proof-secret",
        }),
      ),
    ).toBeInstanceOf(S3MediaObjectStore);
    expect(() =>
      registration.useFactory(
        config({
          driver: "s3",
          bucket: "proof-media",
          region: "us-east-1",
          forcePathStyle: true,
        }),
      ),
    ).toThrow("MEDIA_OBJECT_STORE_NOT_CONFIGURED");
  });

  it("wires the pinned network primitives and explicit provider client", () => {
    const providers = Reflect.getMetadata(
      "providers",
      MediaStagingModule,
    ) as Array<unknown>;
    expect(providers).toEqual(
      expect.arrayContaining([
        HttpsPinnedTransport,
        SystemMetaResolver,
        MetaMediaClient,
        MediaStagingService,
      ]),
    );
  });

  it("exposes only content-free codes from every staging failure", () => {
    const codes = [
      "MEDIA_PROVIDER_INVALID",
      "MEDIA_PROVIDER_UNAVAILABLE",
      "MEDIA_URL_REJECTED",
      "MEDIA_REDIRECT_REJECTED",
      "MEDIA_MIME_MISMATCH",
      "MEDIA_SIZE_INVALID",
      "MEDIA_SIZE_MISMATCH",
      "MEDIA_TOO_LARGE",
      "MEDIA_HASH_MISMATCH",
      "MEDIA_CONTENT_INVALID",
      "MEDIA_OBJECT_CONFLICT",
      "MEDIA_OBJECT_UNAVAILABLE",
      "MEDIA_COMPLETION_CONFLICT",
    ];
    for (const code of codes) {
      const error = new MediaStagingError(
        code as never,
        true,
      );
      expect(error.message).toBe(code);
      const serialized = JSON.parse(JSON.stringify(error)) as Record<
        string,
        unknown
      >;
      expect(Object.keys(serialized).sort()).toEqual([
        "code",
        "definitive",
        "name",
      ]);
      expect(serialized).toEqual({
        code,
        definitive: true,
        name: "MediaStagingError",
      });
      expect(JSON.stringify(error)).not.toContain("undefined");
    }
  });
});
