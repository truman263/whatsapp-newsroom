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

@Module({
  providers: [
    HttpsPinnedTransport,
    SystemMetaResolver,
    MetaMediaClient,
    UnconfiguredMediaObjectStore,
    MediaStagingService,
    { provide: MEDIA_PROVIDER_CLIENT, useExisting: MetaMediaClient },
    { provide: MEDIA_OBJECT_STORE, useExisting: UnconfiguredMediaObjectStore },
  ],
  exports: [MediaStagingService, MEDIA_PROVIDER_CLIENT, MEDIA_OBJECT_STORE],
})
export class MediaStagingModule {}
