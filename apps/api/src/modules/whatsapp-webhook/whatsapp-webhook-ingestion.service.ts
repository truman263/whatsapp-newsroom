import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Provider } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import type {
  NormalizedInboundEvent,
  NormalizedWebhookBatch,
} from "./whatsapp-webhook.types";

export function groupEventIndicesBySender(
  events: readonly NormalizedInboundEvent[],
): ReadonlyMap<string, readonly number[]> {
  const groups = new Map<string, number[]>();
  events.forEach((event, index) => {
    const indices = groups.get(event.senderPhone) ?? [];
    indices.push(index);
    groups.set(event.senderPhone, indices);
  });
  return new Map(
    [...groups.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

type CursorRow = { nextValue: bigint };

@Injectable()
export class WhatsappWebhookIngestionService {
  private readonly logger = new Logger(WhatsappWebhookIngestionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async persist(batch: NormalizedWebhookBatch): Promise<{ inserted: number }> {
    if (batch.events.length === 0) return { inserted: 0 };
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const sequences: bigint[] = Array.from(
          { length: batch.events.length },
          () => -1n,
        );
        for (const [senderPhone, indices] of groupEventIndicesBySender(
          batch.events,
        )) {
          await tx.$executeRaw`
            INSERT INTO "InboundSenderSequence" ("senderPhone", "nextValue", "updatedAt")
            VALUES (${senderPhone}, 0, CURRENT_TIMESTAMP)
            ON CONFLICT ("senderPhone") DO NOTHING
          `;
          const rows = await tx.$queryRaw<CursorRow[]>`
            SELECT "nextValue"
            FROM "InboundSenderSequence"
            WHERE "senderPhone" = ${senderPhone}
            FOR UPDATE
          `;
          const cursor = rows[0];
          if (!cursor) throw new Error("Sender sequence cursor unavailable");
          indices.forEach((eventIndex, offset) => {
            sequences[eventIndex] = cursor.nextValue + BigInt(offset);
          });
          await tx.inboundSenderSequence.update({
            where: { senderPhone },
            data: { nextValue: cursor.nextValue + BigInt(indices.length) },
          });
        }
        if (sequences.some((value) => value < 0n)) {
          throw new Error("Sender sequence allocation incomplete");
        }
        return tx.inboundEvent.createMany({
          data: batch.events.map((event, index) => {
            const senderIngestSequence = sequences[index];
            if (senderIngestSequence === undefined)
              throw new Error("Sender sequence allocation incomplete");
            return {
              provider: Provider.WHATSAPP,
              providerMessageId: event.providerMessageId,
              reporterId: null,
              senderPhone: event.senderPhone,
              senderIngestSequence,
              eventType: event.eventType,
              rawPayload: event.rawPayload,
              providerOccurredAt: event.providerOccurredAt,
            };
          }),
          skipDuplicates: true,
        });
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
