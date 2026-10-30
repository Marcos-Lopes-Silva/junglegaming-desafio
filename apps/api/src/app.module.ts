import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { CoreModule } from '@wagering/wiring';
import { NoopAuthGuard } from './auth/noop-auth.guard.js';
import { correlationId } from './common/correlation-id.middleware.js';
import { DomainExceptionFilter } from './common/domain-exception.filter.js';
import { HealthController } from './health/health.controller.js';
import { WageringController } from './wagering/wagering.controller.js';
import { WalletsController } from './wallets/wallets.controller.js';

@Module({
  imports: [CoreModule],
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    { provide: APP_GUARD, useClass: NoopAuthGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationId).forRoutes('*');
  }
}
