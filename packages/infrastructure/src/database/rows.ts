/**
 * Valores monetários trafegam como `string` porque as colunas são
 * `NUMERIC(20,2)` e o driver do Postgres as entrega exatas: nenhum valor passa
 * por `number`.
 */

export class WalletRow {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class LedgerAccountRow {
  id!: string;
  kind!: string;
  walletId?: string | null;
  currency!: string;
  createdAt!: Date;
}

export class WagerTransactionRow {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  attempts!: number;
  nextAttemptAt?: Date | null;
  createdAt!: Date;
  processedAt?: Date | null;
  observedBalanceAmount?: string | null;
}

export class LedgerEntryRow {
  id!: string;
  accountId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore?: string | null;
  balanceAfter?: string | null;
  createdAt!: Date;
}

export class InboxMessageRow {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export class OutboxMessageRow {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}
