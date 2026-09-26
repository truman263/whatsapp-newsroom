import type { PrismaService } from "../../database/prisma.service";
import { InboundEventProcessingService } from "../reporter-workflow/inbound-event-processing.service";
import type { Round7ApprovalService } from "../reporter-workflow/round7-approval.service";
import type { Round7PublishSagaService } from "./round7-publish-saga.service";

function processor(
  recover: jest.Mock,
  run: jest.Mock,
): InboundEventProcessingService {
  const query = jest
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ blocked: false }]);
  return new InboundEventProcessingService(
    {
      $queryRaw: query,
      approval: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { recover } as unknown as Round7ApprovalService,
    { run } as unknown as Round7PublishSagaService,
  );
}

describe("Round 7 publication processing integration", () => {
  it("does not opportunistically recover a PROCESSING Approval without a stale claim", async () => {
    const recover = jest.fn().mockResolvedValue({
      outcome: "APPROVAL_PENDING",
      approvalId: "approval",
      publishAttemptId: "attempt",
      storyId: "story",
    });
    const run = jest.fn().mockResolvedValue({
      outcome: "PROCESSED",
      publishAttemptId: "attempt",
      storyId: "story",
    });
    await expect(processor(recover, run).process("event")).resolves.toEqual({
      outcome: "NOT_CLAIMED",
    });
    expect(recover).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not enter publication when a PROCESSING event has no Approval lineage", async () => {
    const recover = jest.fn().mockResolvedValue(null);
    const run = jest.fn();
    await expect(processor(recover, run).process("event")).resolves.toEqual({
      outcome: "NOT_CLAIMED",
    });
    expect(run).not.toHaveBeenCalled();
  });
});
