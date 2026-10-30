import { EntitySchema } from '@mikro-orm/postgresql';
import {
  InboxMessageRow,
  LedgerAccountRow,
  LedgerEntryRow,
  OutboxMessageRow,
  WagerTransactionRow,
  WalletRow,
} from './rows.js';

/**
 * Colunas monetárias usam `type: 'string'` com `columnType: 'numeric(20,2)'`.
 * O `DecimalType` do MikroORM converteria para `number`; como string, o valor
 * exato do Postgres chega até `Money.rehydrate`.
 */
const money = { type: 'string', columnType: 'numeric(20,2)' } as const;
const currency = { type: 'string', columnType: 'char(3)' } as const;
const timestamp = { type: 'Date', columnType: 'timestamptz' } as const;

export const WalletSchema = new EntitySchema<WalletRow>({
  class: WalletRow,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { ...currency, fieldName: 'currency' },
    balanceAmount: { ...money, fieldName: 'balance_amount' },
    version: { type: 'integer', fieldName: 'version' },
    createdAt: { ...timestamp, fieldName: 'created_at' },
    updatedAt: { ...timestamp, fieldName: 'updated_at' },
  },
});

export const LedgerAccountSchema = new EntitySchema<LedgerAccountRow>({
  class: LedgerAccountRow,
  tableName: 'ledger_accounts',
  properties: {
    id: { type: 'uuid', primary: true },
    kind: { type: 'string', columnType: 'varchar(32)', fieldName: 'kind' },
    walletId: { type: 'uuid', fieldName: 'wallet_id', nullable: true },
    currency: { ...currency, fieldName: 'currency' },
    createdAt: { ...timestamp, fieldName: 'created_at' },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  class: WagerTransactionRow,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: {
      type: 'string',
      columnType: 'varchar(64)',
      fieldName: 'provider_id',
    },
    externalTransactionId: {
      type: 'string',
      columnType: 'varchar(128)',
      fieldName: 'external_transaction_id',
    },
    idempotencyKey: {
      type: 'string',
      columnType: 'varchar(255)',
      fieldName: 'idempotency_key',
    },
    payloadHash: {
      type: 'string',
      columnType: 'char(64)',
      fieldName: 'payload_hash',
    },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: {
      type: 'string',
      columnType: 'varchar(128)',
      fieldName: 'round_id',
    },
    gameId: {
      type: 'string',
      columnType: 'varchar(128)',
      fieldName: 'game_id',
    },
    kind: { type: 'string', columnType: 'varchar(16)', fieldName: 'kind' },
    amount: { ...money, fieldName: 'amount' },
    currency: { ...currency, fieldName: 'currency' },
    referenceExternalTransactionId: {
      type: 'string',
      columnType: 'varchar(128)',
      fieldName: 'reference_external_transaction_id',
      nullable: true,
    },
    referenceTransactionId: {
      type: 'uuid',
      fieldName: 'reference_transaction_id',
      nullable: true,
    },
    status: { type: 'string', columnType: 'varchar(24)', fieldName: 'status' },
    failureCode: {
      type: 'string',
      columnType: 'varchar(48)',
      fieldName: 'failure_code',
      nullable: true,
    },
    attempts: { type: 'integer', fieldName: 'attempts' },
    nextAttemptAt: {
      ...timestamp,
      fieldName: 'next_attempt_at',
      nullable: true,
    },
    createdAt: { ...timestamp, fieldName: 'created_at' },
    processedAt: { ...timestamp, fieldName: 'processed_at', nullable: true },
    observedBalanceAmount: {
      ...money,
      fieldName: 'observed_balance_amount',
      nullable: true,
    },
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRow>({
  class: LedgerEntryRow,
  tableName: 'ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    accountId: { type: 'uuid', fieldName: 'account_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: {
      type: 'string',
      columnType: 'varchar(8)',
      fieldName: 'direction',
    },
    amount: { ...money, fieldName: 'amount' },
    currency: { ...currency, fieldName: 'currency' },
    balanceBefore: { ...money, fieldName: 'balance_before', nullable: true },
    balanceAfter: { ...money, fieldName: 'balance_after', nullable: true },
    createdAt: { ...timestamp, fieldName: 'created_at' },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRow>({
  class: OutboxMessageRow,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid', fieldName: 'aggregate_id' },
    eventType: {
      type: 'string',
      columnType: 'varchar(64)',
      fieldName: 'event_type',
    },
    payload: { type: 'json', columnType: 'jsonb', fieldName: 'payload' },
    occurredAt: { ...timestamp, fieldName: 'occurred_at' },
    attempts: { type: 'integer', fieldName: 'attempts' },
    nextAttemptAt: {
      ...timestamp,
      fieldName: 'next_attempt_at',
      nullable: true,
    },
    publishedAt: { ...timestamp, fieldName: 'published_at', nullable: true },
  },
});

/** Chave primária composta: a chave natural da dedup é `(consumer, message)`. */
export const InboxMessageSchema = new EntitySchema<InboxMessageRow>({
  class: InboxMessageRow,
  tableName: 'inbox_messages',
  properties: {
    consumerName: {
      type: 'string',
      columnType: 'varchar(64)',
      fieldName: 'consumer_name',
      primary: true,
    },
    messageId: {
      type: 'string',
      columnType: 'varchar(255)',
      fieldName: 'message_id',
      primary: true,
    },
    payloadHash: {
      type: 'string',
      columnType: 'char(64)',
      fieldName: 'payload_hash',
    },
    receivedAt: { ...timestamp, fieldName: 'received_at' },
    processedAt: { ...timestamp, fieldName: 'processed_at', nullable: true },
  },
});

export const ENTITY_SCHEMAS = [
  WalletSchema,
  LedgerAccountSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
