import { Injectable } from "@nestjs/common";
import { MediaStagingError } from "./media-staging.errors";
import type {
  DownloadedMedia,
  MediaObjectStore,
  StoredObjectHead,
} from "./media-staging.types";

@Injectable()
export class UnconfiguredMediaObjectStore implements MediaObjectStore {
  putIfAbsent(
    _key: string,
    _media: DownloadedMedia,
  ): Promise<"CREATED" | "EXISTS"> {
    return Promise.reject(
      new MediaStagingError("MEDIA_OBJECT_UNAVAILABLE", false),
    );
  }
  head(_key: string): Promise<StoredObjectHead | null> {
    return Promise.reject(
      new MediaStagingError("MEDIA_OBJECT_UNAVAILABLE", false),
    );
  }
  read(_key: string): Promise<Buffer> {
    return Promise.reject(
      new MediaStagingError("MEDIA_OBJECT_UNAVAILABLE", false),
    );
  }
}
