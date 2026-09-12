import { Module } from "@nestjs/common";
import { NewsroomPreviewModule } from "../newsroom-preview/newsroom-preview.module";
import { ApprovalPromptService } from "./approval-prompt.service";
import {
  HttpsMetaOutboundTransport,
  WhatsappOutboundClient,
} from "./whatsapp-outbound.client";
import { WhatsappOutboundDispatcher } from "./whatsapp-outbound.dispatcher";
import { WhatsappOutboundStatusService } from "./whatsapp-outbound-status.service";
import { META_OUTBOUND_TRANSPORT } from "./whatsapp-outbound.types";

@Module({
  imports: [NewsroomPreviewModule],
  providers: [
    HttpsMetaOutboundTransport,
    {
      provide: META_OUTBOUND_TRANSPORT,
      useExisting: HttpsMetaOutboundTransport,
    },
    WhatsappOutboundClient,
    ApprovalPromptService,
    WhatsappOutboundDispatcher,
    WhatsappOutboundStatusService,
  ],
  exports: [
    ApprovalPromptService,
    WhatsappOutboundDispatcher,
    WhatsappOutboundStatusService,
  ],
})
export class WhatsappOutboundModule {}
