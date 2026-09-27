import { validateEnvironment, validateWorkerEnvironment } from "./env.schema";

function completeNonTestEnvironment(
  nodeEnvironment: "development" | "production",
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: nodeEnvironment,
    DATABASE_URL: "postgresql://test:test@localhost:5432/newsroom_test",
    WHATSAPP_ACCESS_TOKEN: "test-access-token",
    WHATSAPP_PHONE_NUMBER_ID: "123456789",
    WHATSAPP_VERIFY_TOKEN: "test-verify-token",
    WHATSAPP_APP_SECRET: "test-app-secret",
    WORDPRESS_BASE_URL: "https://wordpress.test",
    WORDPRESS_DRAFT_HMAC_KEY_ID: "test-draft-key",
    WORDPRESS_DRAFT_HMAC_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    WORDPRESS_PUBLISH_HMAC_KEY_ID: "test-publish-key",
    WORDPRESS_PUBLISH_HMAC_SECRET:
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    WORDPRESS_MEDIA_HMAC_KEY_ID: "test-media-key",
    WORDPRESS_MEDIA_HMAC_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    NEWSROOM_PREVIEW_PUBLIC_ORIGIN: "https://newsroom.test",
    NEWSROOM_PREVIEW_HMAC_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    WHATSAPP_GRAPH_API_VERSION: "v0.0",
    ROUND6_CONTROL_CUTOVER_AT: "2026-09-13T16:00:00.000Z",
    ROUND7_CONTROL_CUTOVER_AT: "2026-09-13T17:00:00.000Z",
    NEWSROOM_MEDIA_OBJECT_STORE_DRIVER: "s3",
    NEWSROOM_MEDIA_S3_ENDPOINT: "https://s3.example.test",
    NEWSROOM_MEDIA_S3_REGION: "us-east-1",
    NEWSROOM_MEDIA_S3_BUCKET: "newsroom-media",
    NEWSROOM_MEDIA_S3_ACCESS_KEY_ID: "test-access-key",
    NEWSROOM_MEDIA_S3_SECRET_ACCESS_KEY: "test-secret-key",
    WORKER_PORT: "3001",
    WORKER_BATCH_SIZE: "25",
    WORKER_INBOUND_CADENCE_MS: "1000",
    WORKER_STALE_INBOUND_CADENCE_MS: "5000",
    WORKER_MEDIA_CADENCE_MS: "2000",
    WORKER_DRAFT_CADENCE_MS: "2000",
    WORKER_OUTBOUND_CADENCE_MS: "1000",
    WORKER_STALE_OUTBOUND_CADENCE_MS: "5000",
    WORKER_PUBLISH_CADENCE_MS: "2000",
    WORKER_STALE_INBOUND_MS: "300000",
    WORKER_STALE_OUTBOUND_MS: "300000",
    WORKER_INBOUND_MAX_ATTEMPTS: "5",
    WORKER_BACKOFF_MAX_MS: "30000",
    WORKER_JITTER_PERCENT: "10",
    WORKER_SHUTDOWN_GRACE_MS: "10000",
    WORKER_READINESS_SILENCE_MS: "60000",
  };
}

describe("environment validation", () => {
  it("fails fast when production service configuration is missing", () => {
    expect(() => validateEnvironment({ NODE_ENV: "production" })).toThrow(
      "Environment validation failed",
    );
  });

  it("fails closed for incomplete or insecure production S3 configuration", () => {
    const complete = completeNonTestEnvironment("production");
    expect(
      validateEnvironment(complete).NEWSROOM_MEDIA_OBJECT_STORE_DRIVER,
    ).toBe("s3");
    for (const field of [
      "NEWSROOM_MEDIA_OBJECT_STORE_DRIVER",
      "NEWSROOM_MEDIA_S3_ENDPOINT",
      "NEWSROOM_MEDIA_S3_REGION",
      "NEWSROOM_MEDIA_S3_BUCKET",
      "NEWSROOM_MEDIA_S3_ACCESS_KEY_ID",
      "NEWSROOM_MEDIA_S3_SECRET_ACCESS_KEY",
    ] as const) {
      const missing = { ...complete };
      delete missing[field];
      expect(() => validateEnvironment(missing)).toThrow(
        "Environment validation failed",
      );
    }
    expect(() =>
      validateEnvironment({
        ...complete,
        NEWSROOM_MEDIA_S3_ENDPOINT: "http://s3.example.test",
      }),
    ).toThrow("production S3 endpoint must use HTTPS");
    for (const endpoint of [
      "https://user@s3.example.test",
      "https://s3.example.test/path",
      "https://s3.example.test?x=1",
      "not-a-url",
    ])
      expect(() =>
        validateEnvironment({
          ...complete,
          NEWSROOM_MEDIA_S3_ENDPOINT: endpoint,
        }),
      ).toThrow("Environment validation failed");
    expect(
      validateEnvironment({
        NODE_ENV: "test",
        NEWSROOM_MEDIA_OBJECT_STORE_DRIVER: "s3",
        NEWSROOM_MEDIA_S3_ENDPOINT: "http://127.0.0.1:4566",
        NEWSROOM_MEDIA_S3_BUCKET: "test-media",
        NEWSROOM_MEDIA_S3_ACCESS_KEY_ID: "test",
        NEWSROOM_MEDIA_S3_SECRET_ACCESS_KEY: "test",
      }).NEWSROOM_MEDIA_S3_ENDPOINT,
    ).toBe("http://127.0.0.1:4566");
  });

  it("uses non-secret local defaults for external systems during tests", () => {
    const environment = validateEnvironment({ NODE_ENV: "test" });

    expect(environment).toMatchObject({
      NODE_ENV: "test",
      PORT: 3000,
      DATABASE_URL: "postgresql://test:test@localhost:5432/newsroom_test",
      WHATSAPP_ACCESS_TOKEN: "test-access-token",
      WHATSAPP_PHONE_NUMBER_ID: "123456789",
      WORDPRESS_BASE_URL: "https://wordpress.test",
      NEWSROOM_MEDIA_STAGING_MAX_BYTES: 500000,
      WHATSAPP_MEDIA_REQUEST_TIMEOUT_MS: 5000,
      NEWSROOM_PREVIEW_TTL_SECONDS: 86400,
      NEWSROOM_PREVIEW_PUBLIC_ORIGIN: "https://newsroom.test",
      NEWSROOM_PREVIEW_HMAC_SECRET:
        "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      WHATSAPP_GRAPH_API_VERSION: "v0.0",
      WHATSAPP_OUTBOUND_REQUEST_TIMEOUT_MS: 5000,
      WORKER_PORT: 3001,
      WORKER_BATCH_SIZE: 25,
      ROUND6_CONTROL_CUTOVER_AT: new Date("9999-12-31T23:59:59.999Z"),
      ROUND7_CONTROL_CUTOVER_AT: new Date("9999-12-31T23:59:59.999Z"),
    });
  });

  it("requires at least two inbound recovery attempts", () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: "test",
        WORKER_INBOUND_MAX_ATTEMPTS: "1",
      }),
    ).toThrow("Environment validation failed");
    expect(
      validateEnvironment({
        NODE_ENV: "test",
        WORKER_INBOUND_MAX_ATTEMPTS: "2",
      }).WORKER_INBOUND_MAX_ATTEMPTS,
    ).toBe(2);
    const production = completeNonTestEnvironment("production");
    delete production.WORKER_INBOUND_MAX_ATTEMPTS;
    expect(() => validateWorkerEnvironment(production)).toThrow(
      "WORKER_INBOUND_MAX_ATTEMPTS",
    );
  });

  it("separates production API and strict worker configuration", () => {
    const complete = completeNonTestEnvironment("production");
    const withoutWorker = Object.fromEntries(
      Object.entries(complete).filter(([name]) => !name.startsWith("WORKER_")),
    );
    expect(validateEnvironment(withoutWorker)).toMatchObject({
      NODE_ENV: "production",
      WORKER_PORT: 3001,
    });
    expect(() => validateWorkerEnvironment(withoutWorker)).toThrow(
      "Worker environment validation failed",
    );
    expect(validateWorkerEnvironment(complete)).toMatchObject({
      WORKER_INBOUND_MAX_ATTEMPTS: 5,
      WORKER_READINESS_SILENCE_MS: 60000,
    });
    expect(() =>
      validateWorkerEnvironment({
        ...complete,
        WORKER_INBOUND_MAX_ATTEMPTS: "1",
      }),
    ).toThrow("WORKER_INBOUND_MAX_ATTEMPTS");
    expect(() =>
      validateWorkerEnvironment({
        ...complete,
        WORKER_INBOUND_CADENCE_MS: "99",
      }),
    ).toThrow("WORKER_INBOUND_CADENCE_MS");
  });

  it("requires readiness silence to cover cadence plus successful jitter", () => {
    const complete = completeNonTestEnvironment("production");
    expect(() =>
      validateWorkerEnvironment({
        ...complete,
        WORKER_STALE_INBOUND_CADENCE_MS: "5000",
        WORKER_JITTER_PERCENT: "10",
        WORKER_READINESS_SILENCE_MS: "5499",
      }),
    ).toThrow("maximum successful loop delay");
    expect(
      validateWorkerEnvironment({
        ...complete,
        WORKER_STALE_INBOUND_CADENCE_MS: "5000",
        WORKER_JITTER_PERCENT: "10",
        WORKER_READINESS_SILENCE_MS: "5500",
      }).WORKER_READINESS_SILENCE_MS,
    ).toBe(5500);
  });

  it("requires a canonical Round 6 cutover outside test", () => {
    for (const value of ["2026-09-13T00:00:00Z", "invalid"])
      expect(() =>
        validateEnvironment({
          NODE_ENV: "production",
          ROUND6_CONTROL_CUTOVER_AT: value,
        }),
      ).toThrow("Environment validation failed");
    expect(() => validateEnvironment({ NODE_ENV: "production" })).toThrow(
      "Environment validation failed",
    );
    expect(
      validateEnvironment({
        NODE_ENV: "test",
        ROUND6_CONTROL_CUTOVER_AT: "2026-09-13T00:00:00.000Z",
      }).ROUND6_CONTROL_CUTOVER_AT,
    ).toEqual(new Date("2026-09-13T00:00:00.000Z"));
  });

  it("validates preview and outbound security configuration", () => {
    for (const origin of [
      "http://newsroom.test",
      "https://user@newsroom.test",
      "https://newsroom.test/path",
      "https://newsroom.test/?query=1",
      "https://newsroom.test/#fragment",
    ])
      expect(() =>
        validateEnvironment({
          NODE_ENV: "test",
          NEWSROOM_PREVIEW_PUBLIC_ORIGIN: origin,
        }),
      ).toThrow("Environment validation failed");
    for (const version of ["19.0", "v19", "latest"])
      expect(() =>
        validateEnvironment({
          NODE_ENV: "test",
          WHATSAPP_GRAPH_API_VERSION: version,
        }),
      ).toThrow("Environment validation failed");
  });

  it("requires and parses the canonical Round 7 cutover", () => {
    expect(
      validateEnvironment({ NODE_ENV: "test" }).ROUND7_CONTROL_CUTOVER_AT,
    ).toEqual(new Date("9999-12-31T23:59:59.999Z"));

    for (const nodeEnvironment of ["development", "production"] as const) {
      const complete = completeNonTestEnvironment(nodeEnvironment);
      expect(validateEnvironment(complete)).toMatchObject({
        NODE_ENV: nodeEnvironment,
        ROUND7_CONTROL_CUTOVER_AT: new Date("2026-09-13T17:00:00.000Z"),
      });
      const withoutRound7 = { ...complete };
      delete withoutRound7.ROUND7_CONTROL_CUTOVER_AT;
      expect(() => validateEnvironment(withoutRound7)).toThrow(
        "ROUND7_CONTROL_CUTOVER_AT",
      );
    }

    expect(
      validateEnvironment({
        NODE_ENV: "test",
        ROUND7_CONTROL_CUTOVER_AT: "2026-09-13T17:00:00.000Z",
      }).ROUND7_CONTROL_CUTOVER_AT,
    ).toEqual(new Date("2026-09-13T17:00:00.000Z"));

    for (const value of [
      "2026-09-13T17:00:00Z",
      "2026-09-13T19:00:00.000+02:00",
      "2026-09-13T17:00:00.00Z",
      "2026-02-30T17:00:00.000Z",
      "2026-09-13T24:00:00.000Z",
      " 2026-09-13T17:00:00.000Z",
      "2026-09-13T17:00:00.000Z ",
      "arbitrary text",
    ]) {
      expect(() =>
        validateEnvironment({
          NODE_ENV: "test",
          ROUND7_CONTROL_CUTOVER_AT: value,
        }),
      ).toThrow("Environment validation failed");
    }
  });

  it("validates preview TTL boundaries", () => {
    expect(
      validateEnvironment({
        NODE_ENV: "test",
        NEWSROOM_PREVIEW_TTL_SECONDS: "60",
      }).NEWSROOM_PREVIEW_TTL_SECONDS,
    ).toBe(60);
    expect(
      validateEnvironment({
        NODE_ENV: "test",
        NEWSROOM_PREVIEW_TTL_SECONDS: "604800",
      }).NEWSROOM_PREVIEW_TTL_SECONDS,
    ).toBe(604800);
    for (const value of ["59", "604801", "1.5"])
      expect(() =>
        validateEnvironment({
          NODE_ENV: "test",
          NEWSROOM_PREVIEW_TTL_SECONDS: value,
        }),
      ).toThrow("Environment validation failed");
  });

  it("requires an HTTPS WordPress origin", () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: "test",
        WORDPRESS_BASE_URL: "http://wordpress.test",
      }),
    ).toThrow("Environment validation failed");
    expect(
      validateEnvironment({
        NODE_ENV: "test",
        WORDPRESS_BASE_URL: "https://wordpress.test/subdirectory",
      }).WORDPRESS_BASE_URL,
    ).toBe("https://wordpress.test/subdirectory");
  });

  it("enforces media staging limits and alignment", () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: "test",
        WORDPRESS_MEDIA_MAX_BYTES: "100",
        NEWSROOM_MEDIA_STAGING_MAX_BYTES: "101",
      }),
    ).toThrow("NEWSROOM_MEDIA_STAGING_MAX_BYTES");
    for (const value of ["0", "-1"]) {
      expect(() =>
        validateEnvironment({
          NODE_ENV: "test",
          NEWSROOM_MEDIA_STAGING_MAX_BYTES: value,
        }),
      ).toThrow("Environment validation failed");
    }
    for (const value of ["99", "60001"]) {
      expect(() =>
        validateEnvironment({
          NODE_ENV: "test",
          WHATSAPP_MEDIA_REQUEST_TIMEOUT_MS: value,
        }),
      ).toThrow("Environment validation failed");
    }
  });

  it("accepts the exact boundary where staging equals the WordPress ceiling", () => {
    const environment = validateEnvironment({
      NODE_ENV: "test",
      WORDPRESS_MEDIA_MAX_BYTES: "250000",
      NEWSROOM_MEDIA_STAGING_MAX_BYTES: "250000",
    });
    expect(environment).toMatchObject({
      NEWSROOM_MEDIA_STAGING_MAX_BYTES: 250000,
    });
    expect(() =>
      validateEnvironment({
        NODE_ENV: "test",
        WORDPRESS_MEDIA_MAX_BYTES: "250000",
        NEWSROOM_MEDIA_STAGING_MAX_BYTES: "250001",
      }),
    ).toThrow("NEWSROOM_MEDIA_STAGING_MAX_BYTES");
  });
});
