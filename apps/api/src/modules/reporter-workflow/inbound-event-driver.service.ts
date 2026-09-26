import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { InboundEventProcessingService } from "./inbound-event-processing.service";
import { InboundEventRecoveryService } from "./inbound-event-recovery.service";
import type {
  EventProcessingResult,
  InboundRecoveryResult,
} from "./reporter-workflow.types";

@Injectable()
export class InboundEventDriverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly processing: InboundEventProcessingService,
    private readonly recovery: InboundEventRecoveryService,
  ) {}

  async processReceived(limit: number): Promise<EventProcessingResult[]> {
    validateLimit(limit);
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT candidate."id"
      FROM "InboundEvent" candidate
      WHERE candidate."processingStatus" = 'RECEIVED'::"InboundProcessingStatus"
        AND NOT EXISTS (
          SELECT 1 FROM "InboundEvent" earlier
          WHERE earlier."senderPhone" = candidate."senderPhone"
            AND earlier."senderIngestSequence" < candidate."senderIngestSequence"
            AND earlier."processingStatus" IN ('RECEIVED'::"InboundProcessingStatus", 'PROCESSING'::"InboundProcessingStatus")
        )
      ORDER BY candidate."receivedAt", candidate."id"
      LIMIT ${limit}
    `;
    const results: EventProcessingResult[] = [];
    for (const row of rows) results.push(await this.processing.process(row.id));
    return results;
  }

  async recoverStaleProcessing(input: {
    limit: number;
    staleBefore: Date;
    maxAttempts: number;
  }): Promise<InboundRecoveryResult[]> {
    validateLimit(input.limit);
    const rows = await this.prisma.inboundEvent.findMany({
      where: {
        processingStatus: "PROCESSING",
        processingStartedAt: { lt: input.staleBefore },
      },
      orderBy: [{ processingStartedAt: "asc" }, { id: "asc" }],
      take: input.limit,
      select: { id: true },
    });
    const results: InboundRecoveryResult[] = [];
    for (const row of rows)
      results.push(
        await this.recovery.recoverStale(
          row.id,
          input.staleBefore,
          input.maxAttempts,
        ),
      );
    return results;
  }
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("INVALID_INBOUND_DRIVER_LIMIT");
}
