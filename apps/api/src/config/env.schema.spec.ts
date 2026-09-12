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
      WORDPRESS_BASE_URL: "http://localhost",
      NEWSROOM_MEDIA_STAGING_MAX_BYTES: 500000,
      WHATSAPP_MEDIA_REQUEST_TIMEOUT_MS: 5000,
    });
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
