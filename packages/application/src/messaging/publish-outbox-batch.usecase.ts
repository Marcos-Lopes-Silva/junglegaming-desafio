import type {
  ClockPort,
  EventPublisherPort,
  MetricsPort,
  OutboxRepositoryPort,
  TransactionRunnerPort,
} from '../ports/index.js';

export interface PublishOutboxBatchResult {
  published: number;
  failed: number;
}

export interface PublishOutboxBatchDeps {
  outbox: OutboxRepositoryPort;
  publisher: EventPublisherPort;
  runner: TransactionRunnerPort;
  clock: ClockPort;
  metrics: MetricsPort;
}

export const OUTBOX_BATCH_SIZE = 20;

/**
 * O lote é reservado com `FOR UPDATE SKIP LOCKED` e o lock fica até o commit,
 * depois do envio ao broker, para que dois publishers não enviem a mesma
 * mensagem. Segurar o lock durante o I/O é aceitável porque o lote é pequeno e
 * ninguém mais disputa essas linhas.
 *
 * Se a publicação acontecer e o commit falhar, a mensagem é publicada de novo
 * com o mesmo `MessageDeduplicationId`/`eventId` e o consumidor deduplica.
 */
export class PublishOutboxBatchUseCase {
  constructor(private readonly deps: PublishOutboxBatchDeps) {}

  async execute(
    limit: number = OUTBOX_BATCH_SIZE,
  ): Promise<PublishOutboxBatchResult> {
    const result = await this.deps.runner.run<PublishOutboxBatchResult>(
      async () => {
        const now = this.deps.clock.now();
        const batch = await this.deps.outbox.claimDue(limit, now);

        let published = 0;
        let failed = 0;

        for (const message of batch) {
          try {
            await this.deps.publisher.publish(message);
            message.markPublished(this.deps.clock.now());
            await this.deps.outbox.markPublished(message);
            published += 1;
          } catch {
            // Falha ao publicar: agenda nova tentativa com backoff e segue com
            // o resto do lote.
            message.scheduleRetry(this.deps.clock.now());
            await this.deps.outbox.scheduleRetry(message);
            this.deps.metrics.recordRetry('outbox');
            failed += 1;
          }
        }

        return { published, failed };
      },
    );

    await this.reportLag();

    return result;
  }

  private async reportLag(): Promise<void> {
    const seconds = await this.deps.outbox.oldestPendingAgeSeconds(
      this.deps.clock.now(),
    );
    this.deps.metrics.recordOutboxLag(seconds);
  }
}
