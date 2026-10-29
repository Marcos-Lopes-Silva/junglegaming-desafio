import { DomainError } from '../errors/domain-error.js';
import { Money, type MoneyProps } from '../money/money.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = 'UNBALANCED_LEDGER_ENTRY';

  constructor(
    before: string,
    direction: LedgerDirection,
    amount: string,
    after: string,
  ) {
    super(
      `unbalanced ledger entry: ${before} ${direction} ${amount} != ${after}`,
    );
  }
}

export class InvalidLedgerEntryAmountError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY_AMOUNT';

  constructor(amount: string) {
    super(`ledger entry amount must be strictly positive, got ${amount}`);
  }
}

export interface CreateLedgerEntryProps {
  id: string;
  accountId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  /** Ausentes em contas de contrapartida, que não materializam saldo. */
  balanceBefore?: Money | undefined;
  balanceAfter?: Money | undefined;
  createdAt: Date;
}

export interface LedgerEntryState {
  id: string;
  accountId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps | undefined;
  balanceAfter: MoneyProps | undefined;
  createdAt: Date;
}

/**
 * Lançamento imutável: sem campos mutáveis nem métodos de transição, e a
 * instância nasce congelada.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly accountId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money | undefined,
    public readonly balanceAfter: Money | undefined,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Valida a aritmética do lançamento antes de deixá-lo existir. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryAmountError(props.money.toString());
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.accountId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );

    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        String(props.balanceBefore),
        props.direction,
        props.money.toString(),
        String(props.balanceAfter),
      );
    }

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.accountId,
      state.transactionId,
      state.direction,
      Money.rehydrate(state.money),
      state.balanceBefore ? Money.rehydrate(state.balanceBefore) : undefined,
      state.balanceAfter ? Money.rehydrate(state.balanceAfter) : undefined,
      state.createdAt,
    );
  }

  /**
   * `balanceBefore ± money === balanceAfter`. Contrapartidas não materializam
   * saldo: ausência dos dois lados é válida, apenas um lado presente é
   * inconsistente.
   */
  isBalanced(): boolean {
    if (this.balanceBefore === undefined && this.balanceAfter === undefined) {
      return true;
    }
    if (this.balanceBefore === undefined || this.balanceAfter === undefined) {
      return false;
    }

    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);

    return expected.equals(this.balanceAfter);
  }

  /** `+amount` para crédito, `-amount` para débito. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit
      ? this.money
      : this.money.negate();
  }
}
