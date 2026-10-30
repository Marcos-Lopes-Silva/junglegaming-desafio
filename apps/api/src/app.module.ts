import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { buildLoggerOptions } from '@wagering/infrastructure';
import { CoreModule } from '@wagering/wiring';
import { LoggerModule } from 'nestjs-pino';
import { v7 as uuidv7 } from 'uuid';
import { NoopAuthGuard } from './auth/noop-auth.guard.js';
import { DomainExceptionFilter } from './common/domain-exception.filter.js';
import { HealthController } from './health/health.controller.js';
import { MetricsController } from './metrics/metrics.controller.js';
import { WageringController } from './wagering/wagering.controller.js';
import { WalletsController } from './wallets/wallets.controller.js';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        ...buildLoggerOptions(),
        // Reaproveita o `x-correlation-id` recebido ou gera um novo; o pino-http
        // o expõe em `request.id` para os controllers e o filtro de erro.
        genReqId: (req, res) => {
          const incoming = req.headers['x-correlation-id'];
          const id =
            (Array.isArray(incoming) ? incoming[0] : incoming) ?? uuidv7();
          res.setHeader('x-correlation-id', id);
          return id;
        },
        customProps: (req) => ({ correlationId: (req as { id?: string }).id }),
      },
    }),
    CoreModule,
  ],
  controllers: [
    WalletsController,
    WageringController,
    HealthController,
    MetricsController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: NoopAuthGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {}
