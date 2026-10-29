import { CurrencyMismatchError } from '../money/money.errors.js';
import { Money, type MoneyProps } from '../money/money.js';
import { LedgerDirection } from './ledger-entry.js';
import { InsufficientFundsError } from './wallet.errors.js';

/**
 * Resultado de uma movimentação de saldo, com os dados que o lançamento do
 * ledger precisa. Como toda movimentação devolve esses dados, não dá para mudar
 * o saldo sem gerar o lançamento.
 */
export interface BalanceChange {
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
}

export interface WalletOpening {
  wallet: Wallet;
  openingChange: BalanceChange | undefined;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * A moeda da wallet vem de `initialBalance.currency`.
   *
   * `version` nasce em 1 com o saldo inicial já aplicado: o crédito de
   * abertura é parte da criação, não uma alteração posterior.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at: Date;
  }): WalletOpening {
    const { id, playerId, initialBalance, at } = props;

    if (initialBalance.isNegative()) {
      throw new InsufficientFundsError(
        Money.zero(initialBalance.currency),
        initialBalance,
      );
    }

    const wallet = new Wallet(
      id,
      playerId,
      initialBalance.currency,
      initialBalance,
      1,
      at,
      at,
    );

    if (initialBalance.isZero()) {
      return { wallet, openingChange: undefined };
    }

    return {
      wallet,
      openingChange: {
        direction: LedgerDirection.Credit,
        money: initialBalance,
        balanceBefore: Money.zero(initialBalance.currency),
        balanceAfter: initialBalance,
        walletVersion: 1,
      },
    };
  }

  /** Reconstrução a partir da persistência, sem revalidar transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.rehydrate(state.balance),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(money: Money, at: Date): BalanceChange {
    this.assertSameCurrency(money);

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(money);

    if (balanceAfter.isNegative()) {
      throw new InsufficientFundsError(balanceBefore, money);
    }

    return this.apply(
      LedgerDirection.Debit,
      money,
      balanceBefore,
      balanceAfter,
      at,
    );
  }

  credit(money: Money, at: Date): BalanceChange {
    this.assertSameCurrency(money);

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(money);

    return this.apply(
      LedgerDirection.Credit,
      money,
      balanceBefore,
      balanceAfter,
      at,
    );
  }

  private apply(
    direction: LedgerDirection,
    money: Money,
    balanceBefore: Money,
    balanceAfter: Money,
    at: Date,
  ): BalanceChange {
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;

    return {
      direction,
      money,
      balanceBefore,
      balanceAfter,
      walletVersion: this._version,
    };
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance.toJSON(),
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
