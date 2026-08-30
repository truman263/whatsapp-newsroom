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
    username: string;
    applicationPassword: string;
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
      username: environment.WORDPRESS_USERNAME,
      applicationPassword: environment.WORDPRESS_APPLICATION_PASSWORD,
    },
  };
}
