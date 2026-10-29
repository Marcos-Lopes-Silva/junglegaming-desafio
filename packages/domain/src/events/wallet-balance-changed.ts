import type { MoneyProps } from '../money/money.js';
import type {
  LedgerDirection,
  WalletLedgerEntry,
} from '../wallet/ledger-entry.js';
import type { Wallet } from '../wallet/wallet.js';
import { type EventContext, IntegrationEvent } from './integration-event.js';

/** `data` carrega `MoneyProps` (string decimal), nunca instâncias de `Money`. */
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Publicado só quando o saldo muda. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    if (!entry.balanceBefore || !entry.balanceAfter) {
      throw new Error(
        'WalletBalanceChanged requires a balance-tracking ledger entry',
      );
    }

    return new WalletBalanceChanged({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
