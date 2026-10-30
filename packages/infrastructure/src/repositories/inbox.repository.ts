import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxRepositoryPort } from '@wagering/application';
import type { InboxMessage } from '@wagering/domain';
import { fromInboxMessage, toInboxMessage } from '../database/mappers.js';
import { InboxMessageSchema } from '../database/schemas.js';

export class InboxRepository implements InboxRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  /**
   * `ON CONFLICT DO NOTHING` sobre a PK composta: duplicata é o caso esperado
   * numa entrega at-least-once, e deixar a violação de PK estourar abortaria a
   * transação financeira inteira.
   */
  async receiveIfAbsent(message: InboxMessage): Promise<boolean> {
    const row = fromInboxMessage(message);

    const inserted = await this.em.execute<{ message_id: string }[]>(
      `INSERT INTO inbox_messages
         (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [
        row.consumerName,
        row.messageId,
        row.payloadHash,
        row.receivedAt,
        row.processedAt,
      ],
    );

    return inserted.length === 1;
  }

  async findOne(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined> {
    const row = await this.em.findOne(InboxMessageSchema, {
      consumerName,
      messageId,
    });
    return row ? toInboxMessage(row) : undefined;
  }
}
