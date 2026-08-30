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
  WORDPRESS_USERNAME: string;
  WORDPRESS_APPLICATION_PASSWORD: string;
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
    .uri({ scheme: ['http', 'https'] })
    .when('NODE_ENV', {
      is: 'test',
      then: Joi.optional().default('http://localhost'),
      otherwise: Joi.required(),
    }),
  WORDPRESS_USERNAME: Joi.string().min(1).when('NODE_ENV', {
    is: 'test',
    then: Joi.optional().default('test-wordpress-user'),
    otherwise: Joi.required(),
  }),
  WORDPRESS_APPLICATION_PASSWORD: Joi.string().min(1).when('NODE_ENV', {
    is: 'test',
    then: Joi.optional().default('test-application-password'),
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
    throw new Error(`Environment validation failed: ${validation.error.message}`);
  }

  return validation.value;
}
