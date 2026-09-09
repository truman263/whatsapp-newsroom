import { Module } from "@nestjs/common";
import { WhatsappWebhookController } from "./whatsapp-webhook.controller";
import { WhatsappWebhookIngestionService } from "./whatsapp-webhook-ingestion.service";
import { WhatsappWebhookNormalizer } from "./whatsapp-webhook-normalizer";
import { WhatsappWebhookSignatureService } from "./whatsapp-webhook-signature.service";
import { WhatsappWebhookVerificationService } from "./whatsapp-webhook-verification.service";

@Module({
  controllers: [WhatsappWebhookController],
  providers: [
    WhatsappWebhookVerificationService,
    WhatsappWebhookSignatureService,
    WhatsappWebhookNormalizer,
    WhatsappWebhookIngestionService,
  ],
})
export class WhatsappWebhookModule {}
