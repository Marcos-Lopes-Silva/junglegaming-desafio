import type { MoneyProps } from '../money/money.js';
import type { FailureCode } from '../wagering/failure-code.js';
import type {
  WagerTransaction,
  WagerTransactionKind,
} from '../wagering/wager-transaction.js';
import { type EventContext, IntegrationEvent } from './integration-event.js';

interface WagerTransactionEventBase {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

const baseDataOf = (
  transaction: WagerTransaction,
): WagerTransactionEventBase => ({
  transactionId: transaction.id,
  providerId: transaction.providerId,
  externalTransactionId: transaction.externalTransactionId,
  walletId: transaction.walletId,
  playerId: transaction.playerId,
  roundId: transaction.roundId,
  gameId: transaction.gameId,
  kind: transaction.kind,
  money: transaction.money.toJSON(),
});

export interface WagerTransactionProcessedData extends WagerTransactionEventBase {
  referenceTransactionId: string | undefined;
  /** `false` para `LOSS`, que registra o resultado sem mover saldo. */
  affectedBalance: boolean;
  balanceAfter: MoneyProps;
  processedAt: string;
}

/** Publicado para qualquer transação aplicada, inclusive `LOSS`. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    balanceAfter: MoneyProps,
    affectedBalance: boolean,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: ctx.eventId,
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        ...baseDataOf(transaction),
        referenceTransactionId: transaction.referenceTransactionId,
        affectedBalance,
        balanceAfter,
        processedAt: (transaction.processedAt ?? ctx.occurredAt).toISOString(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionEventBase {
  /** Código que o provedor usa para decidir se reenvia. */
  failureCode: FailureCode;
  balance: MoneyProps;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    balance: MoneyProps,
    ctx: EventContext,
  ): WagerTransactionRejected {
    const failureCode = transaction.failureCode;
    if (!failureCode) {
      throw new Error('WagerTransactionRejected requires a failureCode');
    }

    return new WagerTransactionRejected({
      eventId: ctx.eventId,
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        ...baseDataOf(transaction),
        failureCode,
        balance,
        rejectedAt: (transaction.processedAt ?? ctx.occurredAt).toISOString(),
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventBase {
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string | undefined;
}

/** Publicado quando a transação referenciada ainda não chegou. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    const reference = transaction.referenceExternalTransactionId;
    if (!reference) {
      throw new Error('WagerTransactionPendingReference requires a reference');
    }

    return new WagerTransactionPendingReference({
      eventId: ctx.eventId,
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        ...baseDataOf(transaction),
        referenceExternalTransactionId: reference,
        attempts: transaction.attempts,
        nextAttemptAt: transaction.nextAttemptAt?.toISOString(),
      },
    });
  }
}
