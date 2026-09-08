import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './modules/health/health.module';
import { WordPressDraftModule } from './modules/wordpress-draft/wordpress-draft.module';
import { WordPressMediaModule } from './modules/wordpress-media/wordpress-media.module';

@Module({
  imports: [AppConfigModule, DatabaseModule, HealthModule, WordPressDraftModule, WordPressMediaModule],
})
export class AppModule {}
