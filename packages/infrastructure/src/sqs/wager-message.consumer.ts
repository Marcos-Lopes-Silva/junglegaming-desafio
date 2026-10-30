import type { Message } from '@aws-sdk/client-sqs';
import type {
  ConsumeWagerMessageUseCase,
  MetricsPort,
} from '@wagering/application';
import {
  classifyDeliveryFailure,
  parseWagerTransactionMessage,
} from './message-envelope.js';
import type { SqsGateway } from './sqs.client.js';

/** Interface mínima para não arrastar o logger do Nest para dentro de infra. */
export interface ConsumerLogger {
  info(data: Record<string, unknown>): void;
  warn(data: Record<string, unknown>): void;
  error(data: Record<string, unknown>): void;
}

const RETRY_BASE_SECONDS = 5;
const RETRY_CAP_SECONDS = 300;

export const retryVisibilitySeconds = (receiveCount: number): number =>
  Math.min(
    RETRY_BASE_SECONDS * 2 ** Math.max(receiveCount - 1, 0),
    RETRY_CAP_SECONDS,
  );

export interface WagerMessageConsumerDeps {
  gateway: SqsGateway;
  consume: ConsumeWagerMessageUseCase;
  metrics: MetricsPort;
  logger: ConsumerLogger;
}

/**
 * - `ack` somente depois do commit: se o processo morrer entre o commit e o
 *   `ack`, a redelivery acontece e o inbox transforma o reprocessamento em no-op.
 * - Processamento sequencial: numa fila FIFO, mensagens do mesmo
 *   `MessageGroupId` precisam ser aplicadas em ordem.
 * - Rejeição de negócio recebe `ack`: ela é terminal e já está persistida.
 */
export class WagerMessageConsumer {
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(private readonly deps: WagerMessageConsumerDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.pollForever();
  }

  /**
   * Deixa a mensagem em andamento terminar, pois ela já pode ter commitado, e
   * devolve a visibilidade das que não começaram para outra instância pegá-las
   * sem esperar o timeout.
   */
  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    this.loop = undefined;
  }

  private async pollForever(): Promise<void> {
    const queue = this.deps.gateway.options.transactionsQueue;

    while (this.running) {
      let batch: Message[];
      try {
        batch = await this.deps.gateway.receive(queue);
      } catch (error) {
        if (!this.running) {
          break;
        }
        this.deps.logger.error({
          message: 'sqs receive failed',
          err: String(error),
        });
        await this.pause(1_000);
        continue;
      }

      for (const [index, message] of batch.entries()) {
        if (!this.running) {
          await this.releaseRemaining(queue, batch.slice(index));
          break;
        }
        await this.handle(queue, message);
      }
    }
  }

  private async handle(queue: string, message: Message): Promise<void> {
    const receiptHandle = message.ReceiptHandle;
    if (!receiptHandle || !message.Body) {
      return;
    }

    try {
      const envelope = parseWagerTransactionMessage(message.Body);
      const outcome = await this.deps.consume.execute(envelope);

      // ack só agora: o commit já aconteceu.
      await this.deps.gateway.deleteMessage(queue, receiptHandle);

      this.deps.logger.info({
        message: 'message settled',
        messageId: envelope.messageId,
        outcome: outcome.status,
        ...(outcome.status === 'settled'
          ? {
              transactionId: outcome.transactionId,
              transactionStatus: outcome.transactionStatus,
            }
          : {}),
      });
    } catch (error) {
      await this.onFailure(queue, message, receiptHandle, error);
    }
  }

  private async onFailure(
    queue: string,
    message: Message,
    receiptHandle: string,
    error: unknown,
  ): Promise<void> {
    const decision = classifyDeliveryFailure(error);
    const reason = error instanceof Error ? error.message : String(error);

    if (decision === 'dlq') {
      // Erro permanente: vai direto para a DLQ, sem esperar as 5 entregas da
      // redrive policy.
      await this.sendToDlq(message, reason);
      await this.deps.gateway.deleteMessage(queue, receiptHandle);
      this.deps.metrics.recordDlqMessage(
        error instanceof Error ? error.constructor.name : 'unknown',
      );
      this.deps.logger.error({ message: 'message routed to dlq', reason });
      return;
    }

    // Transitório: não dá `ack`. A visibilidade volta com backoff e, esgotada
    // a redrive policy, o próprio SQS move a mensagem para a DLQ.
    const receiveCount = Number(
      message.Attributes?.ApproximateReceiveCount ?? '1',
    );
    try {
      await this.deps.gateway.changeVisibility(
        queue,
        receiptHandle,
        retryVisibilitySeconds(receiveCount),
      );
    } catch (visibilityError) {
      this.deps.logger.warn({
        message: 'failed to extend visibility',
        err: String(visibilityError),
      });
    }

    this.deps.metrics.recordRetry('consumer');
    this.deps.logger.warn({
      message: 'transient failure, will retry',
      reason,
      receiveCount,
    });
  }

  private async sendToDlq(message: Message, reason: string): Promise<void> {
    try {
      await this.deps.gateway.send({
        queue: this.deps.gateway.options.transactionsDlq,
        body: JSON.stringify({ reason, originalBody: message.Body }),
        groupId: message.Attributes?.MessageGroupId ?? 'malformed',
        deduplicationId: message.MessageId ?? `${Date.now()}`,
      });
    } catch (error) {
      this.deps.logger.error({
        message: 'failed to send to dlq',
        err: String(error),
      });
      throw error;
    }
  }

  private async releaseRemaining(
    queue: string,
    messages: Message[],
  ): Promise<void> {
    for (const message of messages) {
      if (!message.ReceiptHandle) {
        continue;
      }
      try {
        await this.deps.gateway.changeVisibility(
          queue,
          message.ReceiptHandle,
          0,
        );
      } catch (error) {
        this.deps.logger.warn({
          message: 'failed to release message',
          err: String(error),
        });
      }
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
