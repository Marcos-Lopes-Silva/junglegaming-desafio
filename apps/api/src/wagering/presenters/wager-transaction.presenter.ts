import type { SubmitWagerTransactionResult } from '@wagering/application';
import type { MoneyProps, WagerTransaction } from '@wagering/domain';

export interface SubmitWagerTransactionResponse {
  transactionId: string;
  status: string;
  balance: MoneyProps;
  idempotentReplay: boolean;
  /** Presente quando a transação foi rejeitada ou falhou. */
  failureCode?: string;
}

export const presentSubmitResult = (
  result: SubmitWagerTransactionResult,
): SubmitWagerTransactionResponse => {
  const body: SubmitWagerTransactionResponse = {
    transactionId: result.transaction.id,
    status: result.transaction.status,
    balance: result.balance.toJSON(),
    idempotentReplay: result.idempotentReplay,
  };

  const failureCode = result.transaction.failureCode;
  if (failureCode) {
    body.failureCode = failureCode;
  }

  return body;
};

export interface WagerTransactionResponse {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  observedBalance: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

export const presentTransaction = (
  transaction: WagerTransaction,
): WagerTransactionResponse => ({
  transactionId: transaction.id,
  providerId: transaction.providerId,
  externalTransactionId: transaction.externalTransactionId,
  idempotencyKey: transaction.idempotencyKey,
  playerId: transaction.playerId,
  walletId: transaction.walletId,
  roundId: transaction.roundId,
  gameId: transaction.gameId,
  kind: transaction.kind,
  money: transaction.money.toJSON(),
  status: transaction.status,
  failureCode: transaction.failureCode ?? null,
  referenceExternalTransactionId:
    transaction.referenceExternalTransactionId ?? null,
  referenceTransactionId: transaction.referenceTransactionId ?? null,
  observedBalance: transaction.observedBalance?.toJSON() ?? null,
  createdAt: transaction.createdAt.toISOString(),
  processedAt: transaction.processedAt?.toISOString() ?? null,
});
