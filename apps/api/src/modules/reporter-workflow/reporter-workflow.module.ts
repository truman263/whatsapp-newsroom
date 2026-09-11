import { Module } from "@nestjs/common";
import { StoryCollectionModule } from "../story-collection/story-collection.module";
import { ConversationProvisioningService } from "./conversation-provisioning.service";
import { ConversationStateMachineService } from "./conversation-state-machine.service";
import { InboundEventProcessingService } from "./inbound-event-processing.service";
import { ReporterAuthorizationService } from "./reporter-authorization.service";
import { ReporterProvisioningService } from "./reporter-provisioning.service";

@Module({
  imports: [StoryCollectionModule],
  providers: [
    ReporterProvisioningService,
    ReporterAuthorizationService,
    ConversationProvisioningService,
    ConversationStateMachineService,
    InboundEventProcessingService,
  ],
  exports: [
    ReporterProvisioningService,
    ConversationStateMachineService,
    InboundEventProcessingService,
  ],
})
export class ReporterWorkflowModule {}
