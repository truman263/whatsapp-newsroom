import { Module } from "@nestjs/common";
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
import { S3MediaObjectStore } from "./s3-media-object-store";
import { ConfigService } from "@nestjs/config";
import type { ApplicationConfiguration } from "../../config/configuration";
import { MediaRecoveryService } from "./media-recovery.service";

@Module({
  providers: [
    HttpsPinnedTransport,
    SystemMetaResolver,
    MetaMediaClient,
    UnconfiguredMediaObjectStore,
    MediaStagingService,
    MediaRecoveryService,
    { provide: MEDIA_PROVIDER_CLIENT, useExisting: MetaMediaClient },
    {
      provide: MEDIA_OBJECT_STORE,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<ApplicationConfiguration, true>,
      ): S3MediaObjectStore | UnconfiguredMediaObjectStore => {
        const s3 = config.get("mediaObjectStore", { infer: true });
        if (s3.driver !== "s3") return new UnconfiguredMediaObjectStore();
        if (!s3.accessKeyId || !s3.secretAccessKey)
          throw new Error("MEDIA_OBJECT_STORE_NOT_CONFIGURED");
        return new S3MediaObjectStore({
          ...s3,
          accessKeyId: s3.accessKeyId,
          secretAccessKey: s3.secretAccessKey,
          maxReadBytes: config.get("mediaStaging.maxBytes", { infer: true }),
        });
      },
    },
  ],
  exports: [
    MediaStagingService,
    MediaRecoveryService,
    MEDIA_PROVIDER_CLIENT,
    MEDIA_OBJECT_STORE,
  ],
})
export class MediaStagingModule {}
