import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CoreModule } from '@wagering/wiring';
import { WagerConsumerService } from './consumer/wager-consumer.service.js';
import { WorkerController } from './observability/worker.controller.js';
import { OutboxPublisherService } from './schedulers/outbox-publisher.service.js';

/**
 * Roda separado da API, para que o encerramento do consumidor no `SIGTERM`
 * não dependa das conexões HTTP.
 */
@Module({
  imports: [ScheduleModule.forRoot(), CoreModule],
  controllers: [WorkerController],
  providers: [WagerConsumerService, OutboxPublisherService],
})
export class WorkerModule {}
