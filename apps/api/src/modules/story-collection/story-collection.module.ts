import { Module } from "@nestjs/common";
import { ConversationStateMachineService } from "../reporter-workflow/conversation-state-machine.service";
import { StoredWhatsappEventParser } from "./stored-whatsapp-event.parser";
import { StoryCompletenessService } from "./story-completeness.service";
import { StoryEventProcessor } from "./story-event-processor.service";

@Module({
  providers: [
    ConversationStateMachineService,
    StoredWhatsappEventParser,
    StoryEventProcessor,
    StoryCompletenessService,
  ],
  exports: [
    StoredWhatsappEventParser,
    StoryEventProcessor,
    StoryCompletenessService,
  ],
})
export class StoryCollectionModule {}
