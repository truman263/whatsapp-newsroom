import { ConsoleLogger, LogLevel, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import type { ApplicationConfiguration } from './config/configuration';

function logLevelsFor(environment: string | undefined): LogLevel[] {
  if (environment === 'production') {
    return ['log', 'warn', 'error', 'fatal'];
  }

  if (environment === 'test') {
    return ['error', 'fatal'];
  }

  return ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'];
}

async function bootstrap(logger: ConsoleLogger): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger, rawBody: true });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableShutdownHooks();

  const config = app.get(ConfigService<ApplicationConfiguration, true>);
  const port = config.get('app.port', { infer: true });
  await app.listen(port);
}

const logger = new ConsoleLogger('newsroom-api', {
  json: true,
  colors: false,
  logLevels: logLevelsFor(process.env.NODE_ENV),
});

void bootstrap(logger).catch((error: unknown) => {
  const stack = error instanceof Error ? error.stack : undefined;
  logger.error('Application failed to start', stack, 'Bootstrap');
  process.exitCode = 1;
});
