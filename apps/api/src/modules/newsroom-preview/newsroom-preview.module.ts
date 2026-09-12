import { Module } from "@nestjs/common";
import { DraftPreparationModule } from "../draft-preparation/draft-preparation.module";
import { MediaStagingModule } from "../media-staging/media-staging.module";
import { NewsroomPreviewController } from "./newsroom-preview.controller";
import { NewsroomPreviewService } from "./newsroom-preview.service";
import { PreviewTokenService } from "./newsroom-preview-token.service";

@Module({
  imports: [DraftPreparationModule, MediaStagingModule],
  controllers: [NewsroomPreviewController],
  providers: [PreviewTokenService, NewsroomPreviewService],
  exports: [PreviewTokenService],
})
export class NewsroomPreviewModule {}
