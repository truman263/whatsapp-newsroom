import { Module } from "@nestjs/common";
import { MediaStagingModule } from "../media-staging/media-staging.module";
import { WordPressDraftModule } from "../wordpress-draft/wordpress-draft.module";
import { WordPressMediaModule } from "../wordpress-media/wordpress-media.module";
import { DraftPreparationService } from "./draft-preparation.service";

@Module({
  imports: [MediaStagingModule, WordPressDraftModule, WordPressMediaModule],
  providers: [DraftPreparationService],
  exports: [DraftPreparationService],
})
export class DraftPreparationModule {}
