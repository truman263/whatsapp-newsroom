import { PublishAttemptStatus, PublishOperation } from "@prisma/client";
import type { PrismaService } from "../../database/prisma.service";
import { PublishAttemptDriverService } from "./publish-attempt-driver.service";
import type { Round7PublishSagaService } from "./round7-publish-saga.service";

describe("PublishAttemptDriverService", () => {
  it("selects only bounded PENDING/IN_PROGRESS PUBLISH attempts in stable order", async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: "a" }, { id: "b" }]);
    const run = jest.fn().mockResolvedValue({ outcome: "PUBLISH_NOT_CLAIMED" });
    const driver = new PublishAttemptDriverService(
      { publishAttempt: { findMany } } as unknown as PrismaService,
      { run } as unknown as Round7PublishSagaService,
    );
    await expect(driver.runOnce(2)).resolves.toHaveLength(2);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        operation: PublishOperation.PUBLISH,
        status: {
          in: [PublishAttemptStatus.PENDING, PublishAttemptStatus.IN_PROGRESS],
        },
      },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 2,
    });
    expect(run.mock.calls).toEqual([["a"], ["b"]]);
  });

  it.each([0, 101, 1.5])("rejects invalid batch size %s", async (limit) => {
    const driver = new PublishAttemptDriverService(
      {} as PrismaService,
      {} as Round7PublishSagaService,
    );
    await expect(driver.runOnce(limit)).rejects.toThrow(
      "Invalid publish driver batch size.",
    );
  });

  it("contains no timer or automatic activation surface", () => {
    expect(
      Object.getOwnPropertyNames(PublishAttemptDriverService.prototype),
    ).toEqual(["constructor", "runOnce"]);
  });
});
