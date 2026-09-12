import { Module } from "@nestjs/common";
import { MediaStagingModule } from "../media-staging/media-staging.module";
import { ConversationStateMachineService } from "../reporter-workflow/conversation-state-machine.service";
import { StoredWhatsappEventParser } from "./stored-whatsapp-event.parser";
import { StoryCompletenessService } from "./story-completeness.service";
import { StoryEventProcessor } from "./story-event-processor.service";

@Module({
  imports: [MediaStagingModule],
  providers: [
    ConversationStateMachineService,
    StoredWhatsappEventParser,
    StoryEventProcessor,
    StoryCompletenessService,
  ],
  exports: [
    MediaStagingModule,
    StoredWhatsappEventParser,
    StoryEventProcessor,
    StoryCompletenessService,
  ],
})
export class StoryCollectionModule {}
