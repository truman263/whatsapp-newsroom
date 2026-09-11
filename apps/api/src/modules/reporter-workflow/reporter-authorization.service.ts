import { Injectable } from "@nestjs/common";
import { ReporterStatus, type Prisma } from "@prisma/client";

export type AuthorizationResult =
  | { outcome: "ACTIVE"; reporterId: string }
  | { outcome: "UNKNOWN" }
  | { outcome: "INACTIVE" };

@Injectable()
export class ReporterAuthorizationService {
  async authorizeInTransaction(
    tx: Prisma.TransactionClient,
    senderPhone: string,
  ): Promise<AuthorizationResult> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Reporter" WHERE "phoneNumber" = ${senderPhone} FOR UPDATE
    `;
    if (!rows[0]) return { outcome: "UNKNOWN" };
    const reporter = await tx.reporter.findUniqueOrThrow({
      where: { id: rows[0].id },
      select: { id: true, status: true },
    });
    return reporter.status === ReporterStatus.ACTIVE
      ? { outcome: "ACTIVE", reporterId: reporter.id }
      : { outcome: "INACTIVE" };
  }
}
