import { Module } from '@nestjs/common';
import { CoreModule } from '@wagering/wiring';
import { WagerConsumerService } from './consumer/wager-consumer.service.js';
import { WorkerController } from './observability/worker.controller.js';

/**
 * Roda separado da API, para que o encerramento do consumidor no `SIGTERM`
 * não dependa das conexões HTTP.
 */
@Module({
  imports: [CoreModule],
  controllers: [WorkerController],
  providers: [WagerConsumerService],
})
export class WorkerModule {}
