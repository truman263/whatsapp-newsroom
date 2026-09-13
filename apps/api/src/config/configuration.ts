import { Environment, validateEnvironment } from "./env.schema";

export interface ApplicationConfiguration {
  app: {
    environment: Environment["NODE_ENV"];
    port: number;
  };
  database: { url: string };
  whatsapp: {
    accessToken: string;
    phoneNumberId: string;
    verifyToken: string;
    appSecret: string;
    graphApiVersion: string;
    outboundRequestTimeoutMs: number;
  };
  wordpress: {
    baseUrl: string;
    draftHmacKeyId: string;
    draftHmacSecret: string;
    requestTimeoutMs: number;
    reconciliationAttempts: number;
    reconciliationDelayMs: number;
    mediaHmacKeyId: string;
    mediaHmacSecret: string;
    mediaRequestTimeoutMs: number;
    mediaReconciliationAttempts: number;
    mediaReconciliationDelayMs: number;
    mediaMaxBytes: number;
  };
  mediaStaging: {
    maxBytes: number;
    requestTimeoutMs: number;
  };
  preview: { ttlSeconds: number; publicOrigin: string; hmacSecret: string };
  round6: { controlCutoverAt: Date };
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
      graphApiVersion: environment.WHATSAPP_GRAPH_API_VERSION,
      outboundRequestTimeoutMs:
        environment.WHATSAPP_OUTBOUND_REQUEST_TIMEOUT_MS,
    },
    wordpress: {
      baseUrl: environment.WORDPRESS_BASE_URL,
      draftHmacKeyId: environment.WORDPRESS_DRAFT_HMAC_KEY_ID,
      draftHmacSecret: environment.WORDPRESS_DRAFT_HMAC_SECRET,
      requestTimeoutMs: environment.WORDPRESS_REQUEST_TIMEOUT_MS,
      reconciliationAttempts: environment.WORDPRESS_RECONCILIATION_ATTEMPTS,
      reconciliationDelayMs: environment.WORDPRESS_RECONCILIATION_DELAY_MS,
      mediaHmacKeyId: environment.WORDPRESS_MEDIA_HMAC_KEY_ID,
      mediaHmacSecret: environment.WORDPRESS_MEDIA_HMAC_SECRET,
      mediaRequestTimeoutMs: environment.WORDPRESS_MEDIA_REQUEST_TIMEOUT_MS,
      mediaReconciliationAttempts:
        environment.WORDPRESS_MEDIA_RECONCILIATION_ATTEMPTS,
      mediaReconciliationDelayMs:
        environment.WORDPRESS_MEDIA_RECONCILIATION_DELAY_MS,
      mediaMaxBytes: environment.WORDPRESS_MEDIA_MAX_BYTES,
    },
    mediaStaging: {
      maxBytes: environment.NEWSROOM_MEDIA_STAGING_MAX_BYTES,
      requestTimeoutMs: environment.WHATSAPP_MEDIA_REQUEST_TIMEOUT_MS,
    },
    preview: {
      ttlSeconds: environment.NEWSROOM_PREVIEW_TTL_SECONDS,
      publicOrigin: environment.NEWSROOM_PREVIEW_PUBLIC_ORIGIN,
      hmacSecret: environment.NEWSROOM_PREVIEW_HMAC_SECRET,
    },
    round6: { controlCutoverAt: environment.ROUND6_CONTROL_CUTOVER_AT },
  };
}
