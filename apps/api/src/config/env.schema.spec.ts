import { validateEnvironment } from "./env.schema";

describe("environment validation", () => {
  it("fails fast when production service configuration is missing", () => {
    expect(() => validateEnvironment({ NODE_ENV: "production" })).toThrow(
      "Environment validation failed",
    );
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
      ROUND6_CONTROL_CUTOVER_AT: new Date("9999-12-31T23:59:59.999Z"),
    });
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
