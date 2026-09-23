import { Module } from "@nestjs/common";
import { ConversationStateMachineService } from "../reporter-workflow/conversation-state-machine.service";
import { WordPressPublicationModule } from "../wordpress-publication/wordpress-publication.module";
import { PublishAttemptDriverService } from "./publish-attempt-driver.service";
import { Round7PublishSagaService } from "./round7-publish-saga.service";

@Module({
  imports: [WordPressPublicationModule],
  providers: [
    ConversationStateMachineService,
    Round7PublishSagaService,
    PublishAttemptDriverService,
  ],
  exports: [Round7PublishSagaService, PublishAttemptDriverService],
})
export class PublishingModule {}
