import { Injectable } from "@nestjs/common";
import {
  ConversationState,
  MediaProcessingStatus,
  StoryStatus,
  type Prisma,
} from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";

const APPROVED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const SHA256 = /^[0-9a-f]{64}$/u;

@Injectable()
export class StoryCompletenessService {
  constructor(private readonly prisma: PrismaService) {}

  isComplete(reporterId: string, storyId: string): Promise<boolean> {
    return this.isCompleteWithClient(this.prisma, reporterId, storyId);
  }

  async isCompleteWithClient(
    client: Prisma.TransactionClient | PrismaService,
    reporterId: string,
    storyId: string,
  ): Promise<boolean> {
    const story = await client.story.findFirst({
      where: { id: storyId, reporterId },
      include: {
        activeInConversation: true,
        categories: { include: { category: true } },
        media: true,
      },
    });
    if (
      !story ||
      story.status !== StoryStatus.COLLECTING ||
      story.activeInConversation?.reporterId !== reporterId ||
      story.activeInConversation.state !== ConversationState.COLLECTING_MEDIA ||
      !story.headline?.trim() ||
      !story.body?.trim() ||
      !story.byline?.trim() ||
      story.categories.length === 0 ||
      story.categories.some(({ category }) => !category)
    )
      return false;
    return story.media.every(
      (media) =>
        media.status === MediaProcessingStatus.FETCHED &&
        media.mimeType !== null &&
        APPROVED_MIME.has(media.mimeType) &&
        media.fileSizeBytes !== null &&
        media.fileSizeBytes > 0n &&
        media.sha256 !== null &&
        SHA256.test(media.sha256),
    );
  }
}
