import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { AuditActorType, ReporterStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { REPORTER_WORKFLOW_AUDIT } from "./reporter-workflow.audit";
import type {
  ProvisionReporterInput,
  ReporterProvisionResult,
  ReporterStatusResult,
} from "./reporter-workflow.types";
import {
  validatePhoneNumber,
  validateProvisionInput,
} from "./reporter-validation";

type InsertedReporter = { id: string };

@Injectable()
export class ReporterProvisioningService {
  constructor(private readonly prisma: PrismaService) {}

  async provision(
    input: ProvisionReporterInput,
  ): Promise<ReporterProvisionResult> {
    const value = validateProvisionInput(input);
    return this.prisma.$transaction(async (tx) => {
      const id = randomUUID();
      const inserted = await tx.$queryRaw<InsertedReporter[]>`
        INSERT INTO "Reporter" ("id", "phoneNumber", "displayName", "editorialByline", "status", "createdAt", "updatedAt")
        VALUES (${id}::uuid, ${value.phoneNumber}, ${value.displayName}, ${value.editorialByline}, 'ACTIVE'::"ReporterStatus", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT ("phoneNumber") DO NOTHING
        RETURNING "id"
      `;
      if (inserted[0]) {
        await tx.auditLog.create({
          data: {
            eventType: REPORTER_WORKFLOW_AUDIT.REPORTER_PROVISIONED,
            actorType: AuditActorType.SYSTEM,
            reporterId: inserted[0].id,
            entityType: "Reporter",
            entityId: inserted[0].id,
          },
        });
        return { outcome: "CREATED", reporterId: inserted[0].id };
      }
      const existing = await tx.reporter.findUniqueOrThrow({
        where: { phoneNumber: value.phoneNumber },
        select: { id: true, displayName: true, editorialByline: true },
      });
      return existing.displayName === value.displayName &&
        existing.editorialByline === value.editorialByline
        ? { outcome: "ALREADY_EXISTS", reporterId: existing.id }
        : { outcome: "REPORTER_CONFLICT", reporterId: existing.id };
    });
  }

  deactivate(phoneNumber: string): Promise<ReporterStatusResult> {
    return this.setStatus(
      validatePhoneNumber(phoneNumber),
      ReporterStatus.INACTIVE,
    );
  }

  reactivate(phoneNumber: string): Promise<ReporterStatusResult> {
    return this.setStatus(
      validatePhoneNumber(phoneNumber),
      ReporterStatus.ACTIVE,
    );
  }

  private async setStatus(
    phoneNumber: string,
    target: ReporterStatus,
  ): Promise<ReporterStatusResult> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Reporter" WHERE "phoneNumber" = ${phoneNumber} FOR UPDATE
      `;
      if (!locked[0]) return { outcome: "NOT_FOUND" };
      const reporter = await tx.reporter.findUniqueOrThrow({
        where: { id: locked[0].id },
        select: { id: true, status: true },
      });
      if (reporter.status === target)
        return { outcome: "ALREADY_IN_STATE", reporterId: reporter.id };
      await tx.reporter.update({
        where: { id: reporter.id },
        data: { status: target },
      });
      await tx.auditLog.create({
        data: {
          eventType:
            target === ReporterStatus.ACTIVE
              ? REPORTER_WORKFLOW_AUDIT.REPORTER_REACTIVATED
              : REPORTER_WORKFLOW_AUDIT.REPORTER_DEACTIVATED,
          actorType: AuditActorType.SYSTEM,
          reporterId: reporter.id,
          entityType: "Reporter",
          entityId: reporter.id,
          metadata: { from: reporter.status, to: target },
        },
      });
      return { outcome: "UPDATED", reporterId: reporter.id };
    });
  }
}
