import { Environment, validateEnvironment } from './env.schema';

export interface ApplicationConfiguration {
  app: {
    environment: Environment['NODE_ENV'];
    port: number;
  };
  database: { url: string };
  whatsapp: {
    accessToken: string;
    phoneNumberId: string;
    verifyToken: string;
    appSecret: string;
  };
  wordpress: {
    baseUrl: string;
    draftHmacKeyId: string;
    draftHmacSecret: string;
    requestTimeoutMs: number;
    reconciliationAttempts: number;
    reconciliationDelayMs: number;
  };
}

export default function configuration(): ApplicationConfiguration {
  const environment = validateEnvironment(process.env);

  return {
    app: {
      environment: environment.NODE_ENV,
      port: environment.PORT,
    },
    database: { url: environment.DATABASE_URL },
    whatsapp: {
      accessToken: environment.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: environment.WHATSAPP_PHONE_NUMBER_ID,
      verifyToken: environment.WHATSAPP_VERIFY_TOKEN,
      appSecret: environment.WHATSAPP_APP_SECRET,
    },
    wordpress: {
      baseUrl: environment.WORDPRESS_BASE_URL,
      draftHmacKeyId: environment.WORDPRESS_DRAFT_HMAC_KEY_ID,
      draftHmacSecret: environment.WORDPRESS_DRAFT_HMAC_SECRET,
      requestTimeoutMs: environment.WORDPRESS_REQUEST_TIMEOUT_MS,
      reconciliationAttempts: environment.WORDPRESS_RECONCILIATION_ATTEMPTS,
      reconciliationDelayMs: environment.WORDPRESS_RECONCILIATION_DELAY_MS,
    },
  };
}
