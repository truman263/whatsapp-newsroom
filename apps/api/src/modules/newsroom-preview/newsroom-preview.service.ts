import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { MediaProcessingStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import {
  MEDIA_OBJECT_STORE,
  mediaObjectKey,
  type MediaObjectStore,
} from "../media-staging/media-staging.types";
import { DraftPreparationService } from "../draft-preparation/draft-preparation.service";
import { PreviewError } from "./newsroom-preview.errors";
import { PreviewTokenService } from "./newsroom-preview-token.service";
import type { PreviewClaims, PreviewRender } from "./newsroom-preview.types";

const MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const SHA = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

@Injectable()
export class NewsroomPreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: PreviewTokenService,
    private readonly preparations: DraftPreparationService,
    @Inject(MEDIA_OBJECT_STORE) private readonly objects: MediaObjectStore,
  ) {}

  async render(token: string): Promise<PreviewRender> {
    const claims = this.tokens.verify(token);
    await this.authority(claims);
    const story = await this.prisma.story.findUniqueOrThrow({
      where: { id: claims.story_id },
      include: {
        categories: {
          include: { category: true },
          orderBy: { categoryId: "asc" },
        },
        media: { orderBy: [{ position: "asc" }, { id: "asc" }] },
      },
    });
    return {
      headline: story.headline!,
      editorialByline: story.byline!,
      body: story.body!,
      categories: story.categories.map(({ category }) => ({
        name: category.name,
      })),
      media: story.media.map((item) => ({
        id: item.id,
        mimeType: item.mimeType!,
      })),
    };
  }

  async media(
    token: string,
    mediaId: string,
  ): Promise<{ bytes: Buffer; mimeType: string }> {
    const claims = this.tokens.verify(token);
    if (!UUID.test(mediaId)) throw new PreviewError("PREVIEW_UNAVAILABLE");
    await this.authority(claims);
    const item = await this.prisma.storyMedia.findFirst({
      where: { id: mediaId, storyId: claims.story_id },
    });
    if (
      !item ||
      item.status !== MediaProcessingStatus.UPLOADED ||
      !item.wordpressMediaId ||
      item.wordpressMediaId <= 0n ||
      !item.mimeType ||
      !MIME.has(item.mimeType) ||
      !item.fileSizeBytes ||
      item.fileSizeBytes <= 0n ||
      !item.sha256 ||
      !SHA.test(item.sha256)
    )
      throw new PreviewError("PREVIEW_UNAVAILABLE");
    let head;
    let bytes: Buffer;
    try {
      head = await this.objects.head(mediaObjectKey(item.id));
      if (!head) throw new Error();
      bytes = await this.objects.read(mediaObjectKey(item.id));
    } catch {
      throw new PreviewError("MEDIA_BYTES_UNAVAILABLE");
    }
    const size = Number(item.fileSizeBytes);
    if (
      head.size !== size ||
      head.mimeType !== item.mimeType ||
      head.sha256 !== item.sha256 ||
      bytes.length !== size ||
      createHash("sha256").update(bytes).digest("hex") !== item.sha256
    )
      throw new PreviewError("MEDIA_BYTES_INTEGRITY_FAILURE");
    return { bytes, mimeType: item.mimeType };
  }

  private async authority(claims: PreviewClaims): Promise<void> {
    const preparation = await this.prisma.draftPreparation.findUnique({
      where: { id: claims.preparation_id },
    });
    if (
      !preparation ||
      preparation.storyId !== claims.story_id ||
      preparation.storyVersion !== claims.story_version ||
      preparation.wordpressAppliedVersion !==
        claims.wordpress_applied_version ||
      Math.floor(preparation.previewExpiresAt.getTime() / 1000) !== claims.exp
    )
      throw new PreviewError("PREVIEW_VERSION_STALE");
    try {
      await this.preparations.verifyPreparedAuthority(preparation.id);
    } catch {
      throw new PreviewError("PREVIEW_UNAVAILABLE");
    }
  }
}
