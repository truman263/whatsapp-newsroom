import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export interface HealthResponse {
  status: 'ok';
  service: 'newsroom-api';
}

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  check(): HealthResponse {
    return { status: 'ok', service: 'newsroom-api' };
  }

  @Get('live')
  live(): HealthResponse {
    return this.check();
  }

  @Get('ready')
  async ready(): Promise<HealthResponse> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return this.check();
    } catch {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        service: 'newsroom-api',
        reason: 'database_unavailable',
      });
    }
  }
}
