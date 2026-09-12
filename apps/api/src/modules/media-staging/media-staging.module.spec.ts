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

describe("MediaStagingModule wiring", () => {
  it("never selects the test-only filesystem store in the production module", () => {
    const providers = Reflect.getMetadata(
      "providers",
      MediaStagingModule,
    ) as Array<unknown>;
    expect(providers).toBeDefined();
    expect(providers).toContain(UnconfiguredMediaObjectStore);
    expect(providers).toEqual(
      expect.arrayContaining([
        { provide: MEDIA_OBJECT_STORE, useExisting: UnconfiguredMediaObjectStore },
        { provide: MEDIA_PROVIDER_CLIENT, useExisting: MetaMediaClient },
      ]),
    );
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