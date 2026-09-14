import { Module } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./modules/health/health.module";
import { WhatsappWebhookModule } from "./modules/whatsapp-webhook/whatsapp-webhook.module";
import { WordPressDraftModule } from "./modules/wordpress-draft/wordpress-draft.module";
import { WordPressMediaModule } from "./modules/wordpress-media/wordpress-media.module";
import { ReporterWorkflowModule } from "./modules/reporter-workflow/reporter-workflow.module";
import { NewsroomPreviewModule } from "./modules/newsroom-preview/newsroom-preview.module";
import { WordPressPublicationModule } from "./modules/wordpress-publication/wordpress-publication.module";

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    HealthModule,
    WhatsappWebhookModule,
    WordPressDraftModule,
    WordPressMediaModule,
    ReporterWorkflowModule,
    NewsroomPreviewModule,
    WordPressPublicationModule,
  ],
})
export class AppModule {}
