import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { buildLoggerOptions } from '@wagering/infrastructure';
import { CoreModule } from '@wagering/wiring';
import { LoggerModule } from 'nestjs-pino';
import { WagerConsumerService } from './consumer/wager-consumer.service.js';
import { WorkerController } from './observability/worker.controller.js';
import { OutboxPublisherService } from './schedulers/outbox-publisher.service.js';
import { PendingReferenceService } from './schedulers/pending-reference.service.js';

/**
 * Roda separado da API, para que o encerramento do consumidor no `SIGTERM`
 * não dependa das conexões HTTP.
 */
@Module({
  imports: [
    LoggerModule.forRoot({ pinoHttp: buildLoggerOptions() }),
    ScheduleModule.forRoot(),
    CoreModule,
  ],
  controllers: [WorkerController],
  providers: [
    WagerConsumerService,
    OutboxPublisherService,
    PendingReferenceService,
  ],
})
export class WorkerModule {}
