import type { InboundEventType, Prisma } from "@prisma/client";

export interface NormalizedInboundEvent {
  providerMessageId: string;
  senderPhone: string;
  eventType: InboundEventType;
  providerOccurredAt: Date;
  rawPayload: Prisma.InputJsonValue;
}

export interface NormalizedWebhookBatch {
  events: NormalizedInboundEvent[];
  foreignPhoneChanges: number;
  unsupportedChanges: number;
}

export interface WebhookAcknowledgement {
  received: true;
}
