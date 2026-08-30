import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns a deterministic health response', () => {
    expect(new HealthController().check()).toEqual({
      status: 'ok',
      service: 'newsroom-api',
    });
  });
});
