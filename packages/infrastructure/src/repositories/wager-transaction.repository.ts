import { type EntityManager, LockMode } from '@mikro-orm/postgresql';
import type { WagerTransactionRepositoryPort } from '@wagering/application';
import type { WagerTransaction } from '@wagering/domain';
import {
  fromWagerTransaction,
  toWagerTransaction,
} from '../database/mappers.js';
import { WagerTransactionSchema } from '../database/schemas.js';

export class WagerTransactionRepository implements WagerTransactionRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(
      WagerTransactionSchema,
      fromWagerTransaction(transaction),
    );
  }

  /**
   * Devolve `false` se a transação já existia. `ON CONFLICT DO NOTHING` sem alvo
   * cobre tanto `idempotency_key` quanto `(provider_id, external_transaction_id)`.
   * Deixar a unique violation estourar abortaria a transação SQL e derrubaria o
   * lock da wallet junto.
   */
  async insertIfAbsent(transaction: WagerTransaction): Promise<boolean> {
    const row = fromWagerTransaction(transaction);

    const inserted = await this.em.execute<{ id: string }[]>(
      `INSERT INTO wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount, currency,
          reference_external_transaction_id, reference_transaction_id, status,
          failure_code, attempts, next_attempt_at, created_at, processed_at,
          observed_balance_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        row.id,
        row.providerId,
        row.externalTransactionId,
        row.idempotencyKey,
        row.payloadHash,
        row.walletId,
        row.playerId,
        row.roundId,
        row.gameId,
        row.kind,
        row.amount,
        row.currency,
        row.referenceExternalTransactionId,
        row.referenceTransactionId,
        row.status,
        row.failureCode,
        row.attempts,
        row.nextAttemptAt,
        row.createdAt,
        row.processedAt,
        row.observedBalanceAmount,
      ],
    );

    return inserted.length === 1;
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const row = fromWagerTransaction(transaction);

    await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: row.id },
      {
        status: row.status,
        failureCode: row.failureCode ?? null,
        referenceTransactionId: row.referenceTransactionId ?? null,
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt ?? null,
        processedAt: row.processedAt ?? null,
        observedBalanceAmount: row.observedBalanceAmount ?? null,
      },
    );
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionSchema, { id });
    return row ? toWagerTransaction(row) : undefined;
  }

  async lockById(id: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(
      WagerTransactionSchema,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return row ? toWagerTransaction(row) : undefined;
  }

  /**
   * Candidatas a reprocessamento, sem lock.
   *
   * Travar aqui inverteria a ordem de locks da submissão (que trava a wallet
   * primeiro) e poderia causar deadlock. Quem reprocessa trava a wallet e
   * depois relê a linha com `lockById`.
   */
  async findDuePendingReferenceIds(
    limit: number,
    now: Date,
  ): Promise<string[]> {
    const rows = await this.em.execute<{ id: string }[]>(
      `SELECT id FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY next_attempt_at NULLS FIRST, created_at
        LIMIT ?`,
      [now, limit],
    );

    return rows.map((row) => row.id);
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionSchema, {
      idempotencyKey,
    });
    return row ? toWagerTransaction(row) : undefined;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionSchema, {
      providerId,
      externalTransactionId,
    });
    return row ? toWagerTransaction(row) : undefined;
  }

  async hasProcessedReversalFor(
    referenceTransactionId: string,
  ): Promise<boolean> {
    const rows = await this.em.execute<{ exists: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM wager_transactions
          WHERE reference_transaction_id = ?
            AND kind IN ('REFUND', 'ROLLBACK')
            AND status = 'PROCESSED'
       ) AS exists`,
      [referenceTransactionId],
    );

    return rows[0]?.exists === true;
  }
}
