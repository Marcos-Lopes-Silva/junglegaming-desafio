import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxRepositoryPort } from '@wagering/application';
import { OutboxMessage } from '@wagering/domain';
import { fromOutboxMessage } from '../database/mappers.js';
import { OutboxMessageSchema } from '../database/schemas.js';

interface RawOutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string | null;
  published_at: Date | string | null;
}

// `em.execute` devolve a linha crua: o MikroORM só converte tipos quando a
// consulta passa pelo metadata da entidade.
const asDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value);

const toMessage = (raw: RawOutboxRow): OutboxMessage =>
  OutboxMessage.rehydrate({
    id: raw.id,
    aggregateId: raw.aggregate_id,
    eventType: raw.event_type,
    payload: raw.payload,
    occurredAt: asDate(raw.occurred_at),
    attempts: raw.attempts,
    nextAttemptAt: raw.next_attempt_at
      ? asDate(raw.next_attempt_at)
      : undefined,
    publishedAt: raw.published_at ? asDate(raw.published_at) : undefined,
  });

/**
 * A escrita acontece dentro da mesma transação da alteração financeira; a
 * publicação acontece depois do commit, fora desta transação.
 */
export class OutboxRepository implements OutboxRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async insertMany(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    await this.em.insertMany(
      OutboxMessageSchema,
      messages.map(fromOutboxMessage),
    );
  }

  /**
   * `FOR UPDATE SKIP LOCKED` permite que várias instâncias reivindiquem lotes
   * disjuntos em paralelo, sem uma esperar a outra.
   */
  async claimDue(limit: number, now: Date): Promise<OutboxMessage[]> {
    const rows = await this.em.execute<RawOutboxRow[]>(
      `SELECT id, aggregate_id, event_type, payload, occurred_at,
              attempts, next_attempt_at, published_at
         FROM outbox_messages
        WHERE published_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY occurred_at, id
        LIMIT ?
          FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );

    return rows.map(toMessage);
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id },
      { publishedAt: message.publishedAt ?? null, nextAttemptAt: null },
    );
  }

  async scheduleRetry(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
      },
    );
  }

  async oldestPendingAgeSeconds(now: Date): Promise<number> {
    const [row] = await this.em.execute<{ oldest: Date | string | null }[]>(
      `SELECT MIN(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL`,
    );

    if (!row?.oldest) {
      return 0;
    }

    return Math.max(0, (now.getTime() - asDate(row.oldest).getTime()) / 1000);
  }
}
