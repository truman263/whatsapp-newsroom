import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns a deterministic health response', () => {
    expect(new HealthController({} as never).check()).toEqual({
      status: 'ok',
      service: 'newsroom-api',
    });
  });

  it('keeps liveness healthy and readiness unavailable when PostgreSQL fails', async () => {
    const controller = new HealthController({
      $queryRaw: jest.fn().mockRejectedValue(new Error('database unavailable')),
    } as never);
    expect(controller.live()).toEqual({
      status: 'ok',
      service: 'newsroom-api',
    });
    await expect(controller.ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await controller.ready().catch((error: ServiceUnavailableException) => {
      expect(error.getStatus()).toBe(503);
      expect(error.getResponse()).toEqual({
        status: 'not_ready',
        service: 'newsroom-api',
        reason: 'database_unavailable',
      });
    });
  });
});
