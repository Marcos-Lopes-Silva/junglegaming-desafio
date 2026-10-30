import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PublishOutboxBatchUseCase } from '@wagering/application';

const PUBLISH_INTERVAL_MS = Number(
  process.env.OUTBOX_PUBLISH_INTERVAL_MS ?? 1_000,
);

/**
 * A flag evita rodar dois lotes ao mesmo tempo neste processo, caso um lote
 * demore mais que o intervalo. Entre instâncias, quem cuida disso é o
 * `FOR UPDATE SKIP LOCKED`.
 */
@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private busy = false;

  constructor(
    @Inject(PublishOutboxBatchUseCase)
    private readonly publishBatch: PublishOutboxBatchUseCase,
  ) {}

  @Interval(PUBLISH_INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;

    try {
      const { published, failed } = await this.publishBatch.execute();
      if (published > 0 || failed > 0) {
        this.logger.log({
          message: 'outbox batch published',
          published,
          failed,
        });
      }
    } catch (error) {
      this.logger.error({
        message: 'outbox publish failed',
        err: String(error),
      });
    } finally {
      this.busy = false;
    }
  }
}
