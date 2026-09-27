import { Module } from "@nestjs/common";
import { DraftPreparationModule } from "../draft-preparation/draft-preparation.module";
import { PreviewTokenService } from "./newsroom-preview-token.service";

@Module({
  imports: [DraftPreparationModule],
  providers: [PreviewTokenService],
  exports: [PreviewTokenService],
})
export class NewsroomPreviewTokenModule {}
