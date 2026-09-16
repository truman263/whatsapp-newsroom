import { Module } from "@nestjs/common";
import { StoryCollectionModule } from "../story-collection/story-collection.module";
import { DraftPreparationModule } from "../draft-preparation/draft-preparation.module";
import { WhatsappOutboundModule } from "../whatsapp-outbound/whatsapp-outbound.module";
import { ConversationProvisioningService } from "./conversation-provisioning.service";
import { ConversationStateMachineService } from "./conversation-state-machine.service";
import { InboundEventProcessingService } from "./inbound-event-processing.service";
import { ReporterAuthorizationService } from "./reporter-authorization.service";
import { ReporterProvisioningService } from "./reporter-provisioning.service";
import { Round6FinalisationService } from "./round6-finalisation.service";
import { Round6RevisionService } from "./round6-revision.service";
import { Round7ApprovalService } from "./round7-approval.service";
import { WordPressDraftModule } from "../wordpress-draft/wordpress-draft.module";

@Module({
  imports: [
    StoryCollectionModule,
    DraftPreparationModule,
    WhatsappOutboundModule,
    WordPressDraftModule,
  ],
  providers: [
    ReporterProvisioningService,
    ReporterAuthorizationService,
    ConversationProvisioningService,
    ConversationStateMachineService,
    InboundEventProcessingService,
    Round6FinalisationService,
    Round6RevisionService,
    Round7ApprovalService,
  ],
  exports: [
    ReporterProvisioningService,
    ConversationStateMachineService,
    InboundEventProcessingService,
  ],
})
export class ReporterWorkflowModule {}
