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
    publishHmacKeyId: string;
    publishHmacSecret: string;
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
  mediaObjectStore: {
    driver: Environment["NEWSROOM_MEDIA_OBJECT_STORE_DRIVER"];
    bucket: string;
    region: string;
    endpoint?: string;
    forcePathStyle: boolean;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  };
  preview: { ttlSeconds: number; publicOrigin: string; hmacSecret: string };
  round6: { controlCutoverAt: Date };
  round7: { controlCutoverAt: Date };
  worker: {
    port: number;
    batchSize: number;
    cadencesMs: Record<string, number>;
    staleInboundMs: number;
    staleOutboundMs: number;
    inboundMaxAttempts: number;
    backoffMaxMs: number;
    jitterPercent: number;
    shutdownGraceMs: number;
    readinessSilenceMs: number;
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
      publishHmacKeyId: environment.WORDPRESS_PUBLISH_HMAC_KEY_ID,
      publishHmacSecret: environment.WORDPRESS_PUBLISH_HMAC_SECRET,
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
    mediaObjectStore: {
      driver: environment.NEWSROOM_MEDIA_OBJECT_STORE_DRIVER,
      bucket: environment.NEWSROOM_MEDIA_S3_BUCKET,
      region: environment.NEWSROOM_MEDIA_S3_REGION,
      endpoint: environment.NEWSROOM_MEDIA_S3_ENDPOINT,
      forcePathStyle: environment.NEWSROOM_MEDIA_S3_FORCE_PATH_STYLE,
      accessKeyId: environment.NEWSROOM_MEDIA_S3_ACCESS_KEY_ID,
      secretAccessKey: environment.NEWSROOM_MEDIA_S3_SECRET_ACCESS_KEY,
      sessionToken: environment.NEWSROOM_MEDIA_S3_SESSION_TOKEN,
    },
    preview: {
      ttlSeconds: environment.NEWSROOM_PREVIEW_TTL_SECONDS,
      publicOrigin: environment.NEWSROOM_PREVIEW_PUBLIC_ORIGIN,
      hmacSecret: environment.NEWSROOM_PREVIEW_HMAC_SECRET,
    },
    round6: { controlCutoverAt: environment.ROUND6_CONTROL_CUTOVER_AT },
    round7: { controlCutoverAt: environment.ROUND7_CONTROL_CUTOVER_AT },
    worker: {
      port: environment.WORKER_PORT,
      batchSize: environment.WORKER_BATCH_SIZE,
      cadencesMs: {
        inbound: environment.WORKER_INBOUND_CADENCE_MS,
        staleInbound: environment.WORKER_STALE_INBOUND_CADENCE_MS,
        media: environment.WORKER_MEDIA_CADENCE_MS,
        draft: environment.WORKER_DRAFT_CADENCE_MS,
        outbound: environment.WORKER_OUTBOUND_CADENCE_MS,
        staleOutbound: environment.WORKER_STALE_OUTBOUND_CADENCE_MS,
        publish: environment.WORKER_PUBLISH_CADENCE_MS,
      },
      staleInboundMs: environment.WORKER_STALE_INBOUND_MS,
      staleOutboundMs: environment.WORKER_STALE_OUTBOUND_MS,
      inboundMaxAttempts: environment.WORKER_INBOUND_MAX_ATTEMPTS,
      backoffMaxMs: environment.WORKER_BACKOFF_MAX_MS,
      jitterPercent: environment.WORKER_JITTER_PERCENT,
      shutdownGraceMs: environment.WORKER_SHUTDOWN_GRACE_MS,
      readinessSilenceMs: environment.WORKER_READINESS_SILENCE_MS,
    },
  };
}
