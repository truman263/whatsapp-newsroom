import { Injectable } from "@nestjs/common";
import { MediaStagingService } from "./media-staging.service";
import type { MediaStageResult } from "./media-staging.service";
import type { InboundProcessingClaim } from "../reporter-workflow/inbound-processing-contract";

@Injectable()
export class MediaRecoveryService {
  constructor(private readonly staging: MediaStagingService) {}
  recover(
    mediaId: string,
    claimOrEventId: InboundProcessingClaim | string,
  ): Promise<MediaStageResult> {
    return this.staging.reconcile(mediaId, claimOrEventId);
  }
}
