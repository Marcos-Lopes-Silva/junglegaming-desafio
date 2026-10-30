import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  ConsumeWagerMessageUseCase,
  METRICS,
  type MetricsPort,
} from '@wagering/application';
import { SqsGateway, WagerMessageConsumer } from '@wagering/infrastructure';

/**
 * `onApplicationShutdown` espera o loop terminar a mensagem atual. O Nest chama
 * esse hook no `SIGTERM` por causa do `enableShutdownHooks()`.
 */
@Injectable()
export class WagerConsumerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WagerConsumerService.name);
  private readonly consumer: WagerMessageConsumer;

  constructor(
    gateway: SqsGateway,
    @Inject(ConsumeWagerMessageUseCase) consume: ConsumeWagerMessageUseCase,
    @Inject(METRICS) metrics: MetricsPort,
  ) {
    this.consumer = new WagerMessageConsumer({
      gateway,
      consume,
      metrics,
      logger: {
        info: (data) => this.logger.log(data),
        warn: (data) => this.logger.warn(data),
        error: (data) => this.logger.error(data),
      },
    });
  }

  onApplicationBootstrap(): void {
    if (process.env.WORKER_CONSUMER_ENABLED === 'false') {
      this.logger.warn({ message: 'sqs consumer disabled by env' });
      return;
    }
    this.consumer.start();
    this.logger.log({ message: 'sqs consumer started' });
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log({ message: 'draining sqs consumer', signal });
    await this.consumer.stop();
    this.logger.log({ message: 'sqs consumer drained' });
  }
}
