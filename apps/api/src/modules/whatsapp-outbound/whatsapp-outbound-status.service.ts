import { Injectable } from "@nestjs/common";
import {
  OutboundMessageStatus,
  type OutboundMessageStatus as OutboundStatus,
} from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import type { ProviderStatusInput } from "./whatsapp-outbound.types";

@Injectable()
export class WhatsappOutboundStatusService {
  constructor(private readonly prisma: PrismaService) {}

  async applyProviderStatus(
    input: ProviderStatusInput,
  ): Promise<"APPLIED" | "UNCHANGED" | "NOT_FOUND"> {
    if (!input.providerMessageId || input.providerMessageId.length > 191)
      return "NOT_FOUND";
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "OutboundMessage" WHERE "providerMessageId"=${input.providerMessageId} FOR UPDATE`;
      if (rows.length === 0) return "NOT_FOUND";
      const row = await tx.outboundMessage.findUniqueOrThrow({
        where: { id: rows[0]!.id },
      });
      if (row.status === OutboundMessageStatus.DELIVERED) return "UNCHANGED";
      let status: OutboundStatus = row.status;
      if (
        (input.status === "delivered" || input.status === "read") &&
        row.status === OutboundMessageStatus.SENT
      )
        status = OutboundMessageStatus.DELIVERED;
      else if (
        input.status === "sent" &&
        row.status === OutboundMessageStatus.SENDING
      )
        status = OutboundMessageStatus.SENT;
      else if (
        input.status === "failed" &&
        row.status === OutboundMessageStatus.SENT
      )
        status = OutboundMessageStatus.FAILED;
      if (status === row.status) return "UNCHANGED";
      const at = input.occurredAt ?? new Date();
      await tx.outboundMessage.update({
        where: { id: row.id },
        data: {
          status,
          ...(status === OutboundMessageStatus.DELIVERED
            ? { deliveredAt: at }
            : {}),
          ...(status === OutboundMessageStatus.SENT
            ? { sentAt: row.sentAt ?? at }
            : {}),
          ...(status === OutboundMessageStatus.FAILED ? { failedAt: at } : {}),
          lastErrorMessage: null,
        },
      });
      return "APPLIED";
    });
  }

  async isPromptSendProven(outboundMessageId: string): Promise<boolean> {
    const row = await this.prisma.outboundMessage.findUnique({
      where: { id: outboundMessageId },
      select: { status: true },
    });
    return (
      row?.status === OutboundMessageStatus.SENT ||
      row?.status === OutboundMessageStatus.DELIVERED
    );
  }
}
