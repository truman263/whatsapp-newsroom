import Joi from 'joi';

export interface Environment {
  NODE_ENV: 'development' | 'test' | 'production';
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
}

export const environmentSchema = Joi.object<Environment>({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .when('NODE_ENV', {
      is: 'test',
      then: Joi.optional().default('postgresql://test:test@localhost:5432/newsroom_test'),
      otherwise: Joi.required(),
    }),
  WHATSAPP_ACCESS_TOKEN: Joi.string().min(1).when('NODE_ENV', {
    is: 'test',
    then: Joi.optional().default('test-access-token'),
    otherwise: Joi.required(),
  }),
  WHATSAPP_PHONE_NUMBER_ID: Joi.string().min(1).when('NODE_ENV', {
    is: 'test',
    then: Joi.optional().default('test-phone-number-id'),
    otherwise: Joi.required(),
  }),
  WHATSAPP_VERIFY_TOKEN: Joi.string().min(1).when('NODE_ENV', {
    is: 'test',
    then: Joi.optional().default('test-verify-token'),
    otherwise: Joi.required(),
  }),
  WHATSAPP_APP_SECRET: Joi.string().min(1).when('NODE_ENV', {
    is: 'test',
    then: Joi.optional().default('test-app-secret'),
    otherwise: Joi.required(),
  }),
  WORDPRESS_BASE_URL: Joi.string()
    .custom((value: string, helpers) => {
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
          return helpers.error('any.invalid');
        }
        return value;
      } catch {
        return helpers.error('any.invalid');
      }
    })
    .when('NODE_ENV', {
      is: 'test',
      then: Joi.optional().default('http://localhost'),
      otherwise: Joi.required(),
    }),
  WORDPRESS_DRAFT_HMAC_KEY_ID: Joi.string().pattern(/^[a-z0-9][a-z0-9._-]{0,63}$/).when('NODE_ENV', {
    is: 'test',
    then: Joi.optional().default('test-draft-key'),
    otherwise: Joi.required(),
  }),
  WORDPRESS_DRAFT_HMAC_SECRET: Joi.string().custom((value: string, helpers) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return helpers.error('any.invalid');
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === value ? value : helpers.error('any.invalid');
  }).when('NODE_ENV', {
    is: 'test',
    then: Joi.optional().default('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    otherwise: Joi.required(),
  }),
  WORDPRESS_REQUEST_TIMEOUT_MS: Joi.number().integer().min(100).max(60000).default(5000),
  WORDPRESS_RECONCILIATION_ATTEMPTS: Joi.number().integer().min(1).max(10).default(3),
  WORDPRESS_RECONCILIATION_DELAY_MS: Joi.number().integer().min(0).max(10000).default(100),
  WORDPRESS_MEDIA_HMAC_KEY_ID: Joi.string().pattern(/^[a-z0-9][a-z0-9._-]{0,63}$/).when('NODE_ENV', {
    is: 'test',
    then: Joi.optional().default('test-media-key'),
    otherwise: Joi.required(),
  }),
  WORDPRESS_MEDIA_HMAC_SECRET: Joi.string().custom((value: string, helpers) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return helpers.error('any.invalid');
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === value ? value : helpers.error('any.invalid');
  }).when('NODE_ENV', {
    is: 'test',
    then: Joi.optional().default('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    otherwise: Joi.required(),
  }),
  WORDPRESS_MEDIA_REQUEST_TIMEOUT_MS: Joi.number().integer().min(100).max(60000).default(5000),
  WORDPRESS_MEDIA_RECONCILIATION_ATTEMPTS: Joi.number().integer().min(1).max(10).default(3),
  WORDPRESS_MEDIA_RECONCILIATION_DELAY_MS: Joi.number().integer().min(0).max(10000).default(100),
  WORDPRESS_MEDIA_MAX_BYTES: Joi.number().integer().min(1).max(52428800).default(500000),
}).unknown(true);

export function validateEnvironment(source: NodeJS.ProcessEnv): Environment {
  const validation = environmentSchema.validate(source, {
    abortEarly: false,
    allowUnknown: true,
    convert: true,
  });

  if (validation.error) {
    throw new Error(`Environment validation failed: ${validation.error.message}`);
  }

  return validation.value;
}
