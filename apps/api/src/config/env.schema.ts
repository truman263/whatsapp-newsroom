import Joi from "joi";

export interface Environment {
  NODE_ENV: "development" | "test" | "production";
  PORT: number;
  DATABASE_URL: string;
  WHATSAPP_ACCESS_TOKEN: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  WHATSAPP_VERIFY_TOKEN: string;
  WHATSAPP_APP_SECRET: string;
  WORDPRESS_BASE_URL: string;
  WORDPRESS_DRAFT_HMAC_KEY_ID: string;
  WORDPRESS_DRAFT_HMAC_SECRET: string;
  WORDPRESS_REQUEST_TIMEOUT_MS: number;
  WORDPRESS_RECONCILIATION_ATTEMPTS: number;
  WORDPRESS_RECONCILIATION_DELAY_MS: number;
  WORDPRESS_MEDIA_HMAC_KEY_ID: string;
  WORDPRESS_MEDIA_HMAC_SECRET: string;
  WORDPRESS_MEDIA_REQUEST_TIMEOUT_MS: number;
  WORDPRESS_MEDIA_RECONCILIATION_ATTEMPTS: number;
  WORDPRESS_MEDIA_RECONCILIATION_DELAY_MS: number;
  WORDPRESS_MEDIA_MAX_BYTES: number;
  NEWSROOM_MEDIA_STAGING_MAX_BYTES: number;
  WHATSAPP_MEDIA_REQUEST_TIMEOUT_MS: number;
  NEWSROOM_PREVIEW_TTL_SECONDS: number;
  NEWSROOM_PREVIEW_PUBLIC_ORIGIN: string;
  NEWSROOM_PREVIEW_HMAC_SECRET: string;
  WHATSAPP_GRAPH_API_VERSION: string;
  WHATSAPP_OUTBOUND_REQUEST_TIMEOUT_MS: number;
  ROUND6_CONTROL_CUTOVER_AT: Date;
  ROUND7_CONTROL_CUTOVER_AT: Date;
}

export const environmentSchema = Joi.object<Environment>({
  NODE_ENV: Joi.string()
    .valid("development", "test", "production")
    .default("development"),
  PORT: Joi.number().port().default(3000),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ["postgres", "postgresql"] })
    .when("NODE_ENV", {
      is: "test",
      then: Joi.optional().default(
        "postgresql://test:test@localhost:5432/newsroom_test",
      ),
      otherwise: Joi.required(),
    }),
  WHATSAPP_ACCESS_TOKEN: Joi.string()
    .min(1)
    .when("NODE_ENV", {
      is: "test",
      then: Joi.optional().default("test-access-token"),
      otherwise: Joi.required(),
    }),
  WHATSAPP_PHONE_NUMBER_ID: Joi.string()
    .pattern(/^[0-9]{1,32}$/)
    .when("NODE_ENV", {
      is: "test",
      then: Joi.optional().default("123456789"),
      otherwise: Joi.required(),
    }),
  WHATSAPP_VERIFY_TOKEN: Joi.string()
    .min(1)
    .when("NODE_ENV", {
      is: "test",
      then: Joi.optional().default("test-verify-token"),
      otherwise: Joi.required(),
    }),
  WHATSAPP_APP_SECRET: Joi.string()
    .min(1)
    .when("NODE_ENV", {
      is: "test",
      then: Joi.optional().default("test-app-secret"),
      otherwise: Joi.required(),
    }),
  WORDPRESS_BASE_URL: Joi.string()
    .custom((value: string, helpers) => {
      try {
        const url = new URL(value);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        ) {
          return helpers.error("any.invalid");
        }
        return value;
      } catch {
        return helpers.error("any.invalid");
      }
    })
    .when("NODE_ENV", {
      is: "test",
      then: Joi.optional().default("https://wordpress.test"),
      otherwise: Joi.required(),
    }),
  WORDPRESS_DRAFT_HMAC_KEY_ID: Joi.string()
    .pattern(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    .when("NODE_ENV", {
      is: "test",
      then: Joi.optional().default("test-draft-key"),
      otherwise: Joi.required(),
    }),
  WORDPRESS_DRAFT_HMAC_SECRET: Joi.string()
    .custom((value: string, helpers) => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(value))
        return helpers.error("any.invalid");
      const decoded = Buffer.from(value, "base64url");
      return decoded.length === 32 && decoded.toString("base64url") === value
        ? value
        : helpers.error("any.invalid");
    })
    .when("NODE_ENV", {
      is: "test",
      then: Joi.optional().default(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ),
      otherwise: Joi.required(),
    }),
  WORDPRESS_REQUEST_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(60000)
    .default(5000),
  WORDPRESS_RECONCILIATION_ATTEMPTS: Joi.number()
    .integer()
    .min(1)
    .max(10)
    .default(3),
  WORDPRESS_RECONCILIATION_DELAY_MS: Joi.number()
    .integer()
    .min(0)
    .max(10000)
    .default(100),
  WORDPRESS_MEDIA_HMAC_KEY_ID: Joi.string()
    .pattern(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    .when("NODE_ENV", {
      is: "test",
      then: Joi.optional().default("test-media-key"),
      otherwise: Joi.required(),
    }),
  WORDPRESS_MEDIA_HMAC_SECRET: Joi.string()
    .custom((value: string, helpers) => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(value))
        return helpers.error("any.invalid");
      const decoded = Buffer.from(value, "base64url");
      return decoded.length === 32 && decoded.toString("base64url") === value
        ? value
        : helpers.error("any.invalid");
    })
    .when("NODE_ENV", {
      is: "test",
      then: Joi.optional().default(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ),
      otherwise: Joi.required(),
    }),
  WORDPRESS_MEDIA_REQUEST_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(60000)
    .default(5000),
  WORDPRESS_MEDIA_RECONCILIATION_ATTEMPTS: Joi.number()
    .integer()
    .min(1)
    .max(10)
    .default(3),
  WORDPRESS_MEDIA_RECONCILIATION_DELAY_MS: Joi.number()
    .integer()
    .min(0)
    .max(10000)
    .default(100),
  WORDPRESS_MEDIA_MAX_BYTES: Joi.number()
    .integer()
    .min(1)
    .max(52428800)
    .default(500000),
  NEWSROOM_MEDIA_STAGING_MAX_BYTES: Joi.number()
    .integer()
    .min(1)
    .max(52428800)
    .default(500000),
  WHATSAPP_MEDIA_REQUEST_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(60000)
    .default(5000),
  NEWSROOM_PREVIEW_TTL_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(604800)
    .default(86400),
  NEWSROOM_PREVIEW_PUBLIC_ORIGIN: Joi.string()
    .custom((value: string, helpers) => {
      try {
        const url = new URL(value);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        )
          return helpers.error("any.invalid");
        return url.origin;
      } catch {
        return helpers.error("any.invalid");
      }
    })
    .when("NODE_ENV", {
      is: "test",
      then: Joi.optional().default("https://newsroom.test"),
      otherwise: Joi.required(),
    }),
  NEWSROOM_PREVIEW_HMAC_SECRET: Joi.string()
    .custom((value: string, helpers) => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(value))
        return helpers.error("any.invalid");
      const decoded = Buffer.from(value, "base64url");
      return decoded.length === 32 && decoded.toString("base64url") === value
        ? value
        : helpers.error("any.invalid");
    })
    .when("NODE_ENV", {
      is: "test",
      then: Joi.optional().default(
        "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      ),
      otherwise: Joi.required(),
    }),
  WHATSAPP_GRAPH_API_VERSION: Joi.string()
    .pattern(/^v[0-9]+\.[0-9]+$/)
    .when("NODE_ENV", {
      is: "test",
      then: Joi.optional().default("v0.0"),
      otherwise: Joi.required(),
    }),
  WHATSAPP_OUTBOUND_REQUEST_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(60000)
    .default(5000),
  ROUND6_CONTROL_CUTOVER_AT: Joi.string()
    .custom((value: string, helpers) => {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
        return helpers.error("any.invalid");
      const date = new Date(value);
      return !Number.isNaN(date.getTime()) && date.toISOString() === value
        ? date
        : helpers.error("any.invalid");
    })
    .when("NODE_ENV", {
      is: "test",
      then: Joi.optional().default("9999-12-31T23:59:59.999Z"),
      otherwise: Joi.required(),
    }),
  ROUND7_CONTROL_CUTOVER_AT: Joi.string()
    .custom((value: string, helpers) => {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
        return helpers.error("any.invalid");
      const date = new Date(value);
      return !Number.isNaN(date.getTime()) && date.toISOString() === value
        ? date
        : helpers.error("any.invalid");
    })
    .when("NODE_ENV", {
      is: "test",
      then: Joi.optional().default("9999-12-31T23:59:59.999Z"),
      otherwise: Joi.required(),
    }),
}).unknown(true);

export function validateEnvironment(source: NodeJS.ProcessEnv): Environment {
  const validation = environmentSchema.validate(source, {
    abortEarly: false,
    allowUnknown: true,
    convert: true,
  });

  if (validation.error) {
    throw new Error(
      `Environment validation failed: ${validation.error.message}`,
    );
  }

  if (
    validation.value.NEWSROOM_MEDIA_STAGING_MAX_BYTES >
    validation.value.WORDPRESS_MEDIA_MAX_BYTES
  ) {
    throw new Error(
      "Environment validation failed: NEWSROOM_MEDIA_STAGING_MAX_BYTES must not exceed WORDPRESS_MEDIA_MAX_BYTES",
    );
  }

  const round6Cutover: unknown = Reflect.get(
    validation.value,
    "ROUND6_CONTROL_CUTOVER_AT",
  );
  const round7Cutover: unknown = Reflect.get(
    validation.value,
    "ROUND7_CONTROL_CUTOVER_AT",
  );
  return {
    ...validation.value,
    ROUND6_CONTROL_CUTOVER_AT:
      round6Cutover instanceof Date
        ? round6Cutover
        : new Date(String(round6Cutover)),
    ROUND7_CONTROL_CUTOVER_AT:
      round7Cutover instanceof Date
        ? round7Cutover
        : new Date(String(round7Cutover)),
  };
}
