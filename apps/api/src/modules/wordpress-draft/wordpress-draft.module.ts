import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApplicationConfiguration } from '../../config/configuration';
import { WordPressDraftClient } from './wordpress-draft.client';

@Module({
  providers: [{
    provide: WordPressDraftClient,
    inject: [ConfigService],
    useFactory: (config: ConfigService<ApplicationConfiguration, true>): WordPressDraftClient => {
      const wordpress = config.get('wordpress', { infer: true });
      return new WordPressDraftClient({ baseUrl: wordpress.baseUrl, keyId: wordpress.draftHmacKeyId, secret: wordpress.draftHmacSecret, requestTimeoutMs: wordpress.requestTimeoutMs, reconciliationAttempts: wordpress.reconciliationAttempts, reconciliationDelayMs: wordpress.reconciliationDelayMs });
    },
  }],
  exports: [WordPressDraftClient],
})
export class WordPressDraftModule {}
