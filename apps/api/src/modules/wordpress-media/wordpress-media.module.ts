import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApplicationConfiguration } from '../../config/configuration';
import { WordPressMediaClient } from './wordpress-media.client';

@Module({
  providers: [{
    provide: WordPressMediaClient,
    inject: [ConfigService],
    useFactory: (config: ConfigService<ApplicationConfiguration, true>): WordPressMediaClient => {
      const wordpress = config.get('wordpress', { infer: true });
      return new WordPressMediaClient({
        baseUrl: wordpress.baseUrl,
        keyId: wordpress.mediaHmacKeyId,
        secret: wordpress.mediaHmacSecret,
        requestTimeoutMs: wordpress.mediaRequestTimeoutMs,
        reconciliationAttempts: wordpress.mediaReconciliationAttempts,
        reconciliationDelayMs: wordpress.mediaReconciliationDelayMs,
        maxBytes: wordpress.mediaMaxBytes,
      });
    },
  }],
  exports: [WordPressMediaClient],
})
export class WordPressMediaModule {}