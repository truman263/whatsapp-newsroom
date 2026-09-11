import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { AuditActorType, type Conversation, type Prisma } from "@prisma/client";
import { REPORTER_WORKFLOW_AUDIT } from "./reporter-workflow.audit";

type InsertedConversation = { id: string };

@Injectable()
export class ConversationProvisioningService {
  async getOrCreateInTransaction(
    tx: Prisma.TransactionClient,
    reporterId: string,
  ): Promise<Conversation> {
    const id = randomUUID();
    const inserted = await tx.$queryRaw<InsertedConversation[]>`
      INSERT INTO "Conversation" ("id", "reporterId", "state", "currentStoryId", "version", "createdAt", "updatedAt")
      VALUES (${id}::uuid, ${reporterId}::uuid, 'IDLE'::"ConversationState", NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("reporterId") DO NOTHING
      RETURNING "id"
    `;
    const conversation = inserted[0]
      ? await tx.conversation.findUniqueOrThrow({
          where: { id: inserted[0].id },
        })
      : await tx.conversation.findUniqueOrThrow({ where: { reporterId } });
    if (conversation.reporterId !== reporterId)
      throw new Error("Conversation ownership invariant failed");
    if (inserted[0]) {
      await tx.auditLog.create({
        data: {
          eventType: REPORTER_WORKFLOW_AUDIT.CONVERSATION_PROVISIONED,
          actorType: AuditActorType.SYSTEM,
          reporterId,
          entityType: "Conversation",
          entityId: conversation.id,
        },
      });
    }
    return conversation;
  }
}
