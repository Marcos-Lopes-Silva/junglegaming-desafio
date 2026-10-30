import type { EventPublisherPort } from '@wagering/application';
import type { OutboxMessage } from '@wagering/domain';
import type { SqsGateway } from './sqs.client.js';

/**
 * `MessageGroupId` é o `aggregateId` (a wallet): eventos da mesma wallet chegam
 * em ordem. `MessageDeduplicationId` é o `eventId`, estável entre
 * republicações: se uma instância publica e morre antes do commit, a
 * republicação é reconhecida pelo broker e deduplicada pelo consumidor.
 */
export class SqsEventPublisher implements EventPublisherPort {
  constructor(private readonly gateway: SqsGateway) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.gateway.send({
      queue: this.gateway.options.eventsQueue,
      body: JSON.stringify(message.payload),
      groupId: message.aggregateId,
      deduplicationId: message.id,
    });
  }
}
