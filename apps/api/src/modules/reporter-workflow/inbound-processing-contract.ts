import { InboundProcessingStatus, type Prisma } from "@prisma/client";
import type { PrismaService } from "../../database/prisma.service";

/** Explicitly supported durable inbound processing contracts. */
export const CURRENT_INBOUND_PROCESSING_CONTRACT_VERSION = 1;

export type InboundProcessingClaim = {
  eventId: string;
  processingAttempt: number;
  processingContractVersion: number;
};

export class InboundProcessingFenceError extends Error {
  readonly code = "INBOUND_PROCESSING_FENCE_LOST";

  constructor() {
    super("Inbound processing claim fence lost");
  }
}

const SUPPORTED_INBOUND_PROCESSING_CONTRACT_VERSIONS: ReadonlySet<number> =
  new Set([CURRENT_INBOUND_PROCESSING_CONTRACT_VERSION]);

export function supportsInboundProcessingContractVersion(
  version: number | null,
): boolean {
  return (
    version !== null &&
    Number.isSafeInteger(version) &&
    SUPPORTED_INBOUND_PROCESSING_CONTRACT_VERSIONS.has(version)
  );
}

export async function requireInboundProcessingClaim(
  tx: Prisma.TransactionClient,
  claim: InboundProcessingClaim,
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "InboundEvent" WHERE "id"=${claim.eventId}::uuid FOR UPDATE`;
  const event = await tx.inboundEvent.findUnique({
    where: { id: claim.eventId },
    select: {
      processingStatus: true,
      processingAttempts: true,
      processingContractVersion: true,
    },
  });
  if (
    event?.processingStatus !== InboundProcessingStatus.PROCESSING ||
    event.processingAttempts < 1 ||
    !supportsInboundProcessingContractVersion(
      event.processingContractVersion,
    ) ||
    event.processingAttempts !== claim.processingAttempt ||
    event.processingContractVersion !== claim.processingContractVersion
  )
    throw new InboundProcessingFenceError();
}

export async function readInboundProcessingClaim(
  prisma: PrismaService | Prisma.TransactionClient,
  eventId: string,
): Promise<InboundProcessingClaim> {
  const event = await prisma.inboundEvent.findUnique({
    where: { id: eventId },
    select: {
      processingStatus: true,
      processingAttempts: true,
      processingContractVersion: true,
    },
  });
  if (
    event?.processingStatus !== InboundProcessingStatus.PROCESSING ||
    event.processingAttempts < 1 ||
    event.processingContractVersion === null ||
    !supportsInboundProcessingContractVersion(event.processingContractVersion)
  )
    throw new InboundProcessingFenceError();
  return {
    eventId,
    processingAttempt: event.processingAttempts,
    processingContractVersion: event.processingContractVersion,
  };
}
