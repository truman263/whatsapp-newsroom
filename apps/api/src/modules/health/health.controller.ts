import { Controller, Get } from '@nestjs/common';

export interface HealthResponse {
  status: 'ok';
  service: 'newsroom-api';
}

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return { status: 'ok', service: 'newsroom-api' };
  }
}
