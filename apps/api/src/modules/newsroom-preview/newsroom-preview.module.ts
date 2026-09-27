import { Module } from "@nestjs/common";
import { DraftPreparationModule } from "../draft-preparation/draft-preparation.module";
import { MediaStagingModule } from "../media-staging/media-staging.module";
import { NewsroomPreviewController } from "./newsroom-preview.controller";
import { NewsroomPreviewService } from "./newsroom-preview.service";
import { NewsroomPreviewTokenModule } from "./newsroom-preview-token.module";

@Module({
  imports: [
    NewsroomPreviewTokenModule,
    DraftPreparationModule,
    MediaStagingModule,
  ],
  controllers: [NewsroomPreviewController],
  providers: [NewsroomPreviewService],
  exports: [NewsroomPreviewTokenModule],
})
export class NewsroomPreviewModule {}
