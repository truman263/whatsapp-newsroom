import { Injectable } from "@nestjs/common";
import { DraftPreparationService } from "./draft-preparation.service";
import type { PreparationOutcome } from "./draft-preparation.types";

@Injectable()
export class DraftRecoveryService {
  constructor(private readonly preparation: DraftPreparationService) {}
  recover(limit = 25): Promise<PreparationOutcome[]> {
    return this.preparation.recoverUnfinished(
      Math.max(1, Math.min(50, Math.floor(limit))),
    );
  }
}
