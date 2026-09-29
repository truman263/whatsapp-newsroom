import { Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

type BacklogRow = { subsystem: string; status: string; count: bigint; oldest: Date | null };

@Injectable()
export class BacklogMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async render(): Promise<string> {
    const rows = await this.prisma.$queryRaw<BacklogRow[]>`
      SELECT 'inbound' subsystem, "processingStatus"::text status, COUNT(*)::bigint count,
        MIN(CASE WHEN "processingStatus"='PROCESSING' THEN COALESCE("processingStartedAt", "receivedAt") ELSE "receivedAt" END) oldest
      FROM "InboundEvent" WHERE "processingStatus" IN ('RECEIVED','PROCESSING','FAILED','IGNORED') GROUP BY "processingStatus"
      UNION ALL
      SELECT 'media', "status"::text, COUNT(*)::bigint, MIN("updatedAt") FROM "StoryMedia"
      WHERE "status" IN ('RECEIVED','FETCHING','UPLOADING','FAILED') GROUP BY "status"
      UNION ALL
      SELECT 'draft', "status"::text, COUNT(*)::bigint, MIN("updatedAt") FROM "DraftPreparation"
      WHERE "status" IN ('ACTIVE','RECONCILIATION_REQUIRED','BLOCKED','FAILED') GROUP BY "status"
      UNION ALL
      SELECT 'outbound', "status"::text, COUNT(*)::bigint, MIN("updatedAt") FROM "OutboundMessage"
      WHERE "status" IN ('PENDING','SENDING','FAILED') GROUP BY "status"
      UNION ALL
      SELECT 'publish', "status"::text, COUNT(*)::bigint, MIN("updatedAt") FROM "PublishAttempt"
      WHERE "operation"='PUBLISH' AND "status" IN ('PENDING','IN_PROGRESS','RECONCILIATION_REQUIRED','FAILED') GROUP BY "status"
      ORDER BY subsystem, status
    `;
    const now = Date.now();
    const lines = [
      "# TYPE newsroom_worker_backlog gauge",
      "# TYPE newsroom_worker_backlog_oldest_age_seconds gauge",
    ];
    for (const row of rows) {
      const label = `{subsystem="${row.subsystem}",status="${row.status}"}`;
      lines.push(`newsroom_worker_backlog${label} ${row.count.toString()}`);
      lines.push(`newsroom_worker_backlog_oldest_age_seconds${label} ${row.oldest ? Math.max(0, (now - row.oldest.getTime()) / 1000) : 0}`);
    }
    const uncertain = await this.prisma.outboundMessage.count({
      where: { status: "SENDING", lastErrorCode: "WHATSAPP_SEND_OUTCOME_UNCERTAIN" },
    });
    lines.push(`newsroom_worker_outbound_uncertain_hold ${uncertain}`);
    return `${lines.join("\n")}\n`;
  }
}
