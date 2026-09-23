import { Injectable } from "@nestjs/common";
import { PublishAttemptStatus, PublishOperation } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { Round7PublishSagaService } from "./round7-publish-saga.service";
import type { PublishSagaResult } from "./round7-publish.types";

@Injectable()
export class PublishAttemptDriverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly saga: Round7PublishSagaService,
  ) {}

  async runOnce(limit = 25): Promise<PublishSagaResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid publish driver batch size.");
    const attempts = await this.prisma.publishAttempt.findMany({
      where: {
        operation: PublishOperation.PUBLISH,
        status: {
          in: [PublishAttemptStatus.PENDING, PublishAttemptStatus.IN_PROGRESS],
        },
      },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit,
    });
    const results: PublishSagaResult[] = [];
    for (const attempt of attempts)
      results.push(await this.saga.run(attempt.id));
    return results;
  }
}
