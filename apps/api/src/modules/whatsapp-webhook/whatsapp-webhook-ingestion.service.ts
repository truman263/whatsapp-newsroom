import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Provider } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import type { NormalizedWebhookBatch } from "./whatsapp-webhook.types";

@Injectable()
export class WhatsappWebhookIngestionService {
  private readonly logger = new Logger(WhatsappWebhookIngestionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async persist(batch: NormalizedWebhookBatch): Promise<{ inserted: number }> {
    if (batch.events.length === 0) return { inserted: 0 };
    try {
      const result = await this.prisma.inboundEvent.createMany({
        data: batch.events.map((event) => ({
          provider: Provider.WHATSAPP,
          providerMessageId: event.providerMessageId,
          reporterId: null,
          senderPhone: event.senderPhone,
          eventType: event.eventType,
          rawPayload: event.rawPayload,
          providerOccurredAt: event.providerOccurredAt,
        })),
        skipDuplicates: true,
      });
      this.logger.log({
        event:
          result.count === 0
            ? "inbound_batch_duplicate"
            : "inbound_batch_persisted",
        candidates: batch.events.length,
        inserted: result.count,
      });
      return { inserted: result.count };
    } catch {
      this.logger.error({
        event: "database_failure",
        operation: "whatsapp_webhook_ingestion",
      });
      throw new ServiceUnavailableException("Webhook persistence unavailable.");
    }
  }
}
