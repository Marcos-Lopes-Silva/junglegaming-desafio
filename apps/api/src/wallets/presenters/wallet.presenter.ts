import type { LedgerPage, ReconciliationResult } from '@wagering/application';
import type { MoneyProps, Wallet } from '@wagering/domain';
import { encodeCursor } from './cursor.codec.js';

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export const presentWallet = (wallet: Wallet): WalletResponse => ({
  id: wallet.id,
  playerId: wallet.playerId,
  balance: wallet.balance.toJSON(),
  version: wallet.version,
});

export interface LedgerEntryResponse {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps | null;
  balanceAfter: MoneyProps | null;
  createdAt: string;
}

export interface LedgerPageResponse {
  entries: LedgerEntryResponse[];
  nextCursor: string | null;
}

export const presentLedgerPage = (page: LedgerPage): LedgerPageResponse => ({
  entries: page.entries.map((entry) => ({
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore?.toJSON() ?? null,
    balanceAfter: entry.balanceAfter?.toJSON() ?? null,
    createdAt: entry.createdAt.toISOString(),
  })),
  nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
});

export interface ReconciliationResponse {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export const presentReconciliation = (
  result: ReconciliationResult,
): ReconciliationResponse => ({
  walletId: result.walletId,
  storedBalance: result.storedBalance.toJSON(),
  calculatedBalance: result.calculatedBalance.toJSON(),
  difference: result.difference.toJSON(),
  consistent: result.consistent,
  checkedEntries: result.checkedEntries,
});
