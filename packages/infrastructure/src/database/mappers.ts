import {
  InboxMessage,
  LedgerAccount,
  type LedgerAccountKind,
  type LedgerDirection,
  type OutboxMessage,
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
  Wallet,
  WalletLedgerEntry,
  type FailureCode,
} from '@wagering/domain';
import type {
  InboxMessageRow,
  LedgerAccountRow,
  LedgerEntryRow,
  OutboxMessageRow,
  WagerTransactionRow,
  WalletRow,
} from './rows.js';

export const toWallet = (row: WalletRow): Wallet =>
  Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: { amount: row.balanceAmount, currency: row.currency },
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

export const fromWallet = (wallet: Wallet): WalletRow => {
  const state = wallet.toState();
  return {
    id: state.id,
    playerId: state.playerId,
    currency: state.currency,
    balanceAmount: state.balance.amount,
    version: state.version,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
};

export const toLedgerAccount = (row: LedgerAccountRow): LedgerAccount =>
  LedgerAccount.rehydrate({
    id: row.id,
    kind: row.kind as LedgerAccountKind,
    walletId: row.walletId ?? undefined,
    currency: row.currency,
    createdAt: row.createdAt,
  });

export const fromLedgerAccount = (
  account: LedgerAccount,
): LedgerAccountRow => ({
  id: account.id,
  kind: account.kind,
  walletId: account.walletId ?? null,
  currency: account.currency,
  createdAt: account.createdAt,
});

export const toLedgerEntry = (row: LedgerEntryRow): WalletLedgerEntry =>
  WalletLedgerEntry.rehydrate({
    id: row.id,
    accountId: row.accountId,
    transactionId: row.transactionId,
    direction: row.direction as LedgerDirection,
    money: { amount: row.amount, currency: row.currency },
    balanceBefore:
      row.balanceBefore == null
        ? undefined
        : { amount: row.balanceBefore, currency: row.currency },
    balanceAfter:
      row.balanceAfter == null
        ? undefined
        : { amount: row.balanceAfter, currency: row.currency },
    createdAt: row.createdAt,
  });

export const fromLedgerEntry = (entry: WalletLedgerEntry): LedgerEntryRow => ({
  id: entry.id,
  accountId: entry.accountId,
  transactionId: entry.transactionId,
  direction: entry.direction,
  amount: entry.money.toString(),
  currency: entry.money.currency,
  balanceBefore: entry.balanceBefore?.toString() ?? null,
  balanceAfter: entry.balanceAfter?.toString() ?? null,
  createdAt: entry.createdAt,
});

export const toWagerTransaction = (
  row: WagerTransactionRow,
): WagerTransaction =>
  WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: { amount: row.amount, currency: row.currency },
    referenceExternalTransactionId:
      row.referenceExternalTransactionId ?? undefined,
    createdAt: row.createdAt,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: (row.failureCode as FailureCode | null) ?? undefined,
    processedAt: row.processedAt ?? undefined,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt ?? undefined,
    observedBalance:
      row.observedBalanceAmount == null
        ? undefined
        : { amount: row.observedBalanceAmount, currency: row.currency },
  });

export const fromWagerTransaction = (
  tx: WagerTransaction,
): WagerTransactionRow => ({
  id: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  idempotencyKey: tx.idempotencyKey,
  payloadHash: tx.payloadHash,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  amount: tx.money.toString(),
  currency: tx.money.currency,
  referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
  referenceTransactionId: tx.referenceTransactionId ?? null,
  status: tx.status,
  failureCode: tx.failureCode ?? null,
  attempts: tx.attempts,
  nextAttemptAt: tx.nextAttemptAt ?? null,
  createdAt: tx.createdAt,
  processedAt: tx.processedAt ?? null,
  observedBalanceAmount: tx.observedBalance?.toString() ?? null,
});

export const fromOutboxMessage = (
  message: OutboxMessage,
): OutboxMessageRow => ({
  id: message.id,
  aggregateId: message.aggregateId,
  eventType: message.eventType,
  payload: message.payload,
  occurredAt: message.occurredAt,
  attempts: message.attempts,
  nextAttemptAt: message.nextAttemptAt ?? null,
  publishedAt: message.publishedAt ?? null,
});

export const toInboxMessage = (row: InboxMessageRow): InboxMessage =>
  InboxMessage.rehydrate({
    consumerName: row.consumerName,
    messageId: row.messageId,
    payloadHash: row.payloadHash,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt ?? undefined,
  });

export const fromInboxMessage = (message: InboxMessage): InboxMessageRow => ({
  consumerName: message.consumerName,
  messageId: message.messageId,
  payloadHash: message.payloadHash,
  receivedAt: message.receivedAt,
  processedAt: message.processedAt ?? null,
});
