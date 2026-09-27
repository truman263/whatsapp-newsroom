import { Module } from "@nestjs/common";
import { AppConfigModule } from "../config/config.module";
import { DatabaseModule } from "../database/database.module";
import { DraftPreparationModule } from "../modules/draft-preparation/draft-preparation.module";
import { MediaStagingModule } from "../modules/media-staging/media-staging.module";
import { PublishingModule } from "../modules/publishing/publishing.module";
import { ReporterWorkflowModule } from "../modules/reporter-workflow/reporter-workflow.module";
import { WhatsappOutboundModule } from "../modules/whatsapp-outbound/whatsapp-outbound.module";
import { WorkerMetricsService } from "./worker-metrics.service";
import { WorkerOperationalController } from "./worker-operational.controller";
import { WorkerOrchestratorService } from "./worker-orchestrator.service";
import { BacklogMetricsService } from "./backlog-metrics.service";

@Module({
  imports: [AppConfigModule, DatabaseModule, ReporterWorkflowModule, MediaStagingModule, DraftPreparationModule, WhatsappOutboundModule, PublishingModule],
  controllers: [WorkerOperationalController],
  providers: [WorkerMetricsService, BacklogMetricsService, WorkerOrchestratorService],
  exports: [WorkerMetricsService, WorkerOrchestratorService],
})
export class WorkerModule {}
