import { validateEnvironment } from './env.schema';

describe('environment validation', () => {
  it('fails fast when production service configuration is missing', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'production' })).toThrow(
      'Environment validation failed',
    );
  });

  it('uses non-secret local defaults for external systems during tests', () => {
    const environment = validateEnvironment({ NODE_ENV: 'test' });

    expect(environment).toMatchObject({
      NODE_ENV: 'test',
      PORT: 3000,
      DATABASE_URL: 'postgresql://test:test@localhost:5432/newsroom_test',
      WHATSAPP_ACCESS_TOKEN: 'test-access-token',
      WORDPRESS_BASE_URL: 'http://localhost',
    });
  });
});
