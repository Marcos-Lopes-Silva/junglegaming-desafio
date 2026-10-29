import { DomainError } from '../errors/domain-error.js';

export class InvalidMoneyAmountError extends DomainError {
  readonly code = 'INVALID_MONEY_AMOUNT';

  constructor(received: unknown, reason: string) {
    super(`invalid money amount ${JSON.stringify(received)}: ${reason}`);
  }
}

export class InvalidCurrencyError extends DomainError {
  readonly code = 'INVALID_CURRENCY';

  constructor(received: unknown) {
    super(
      `invalid ISO-4217 currency ${JSON.stringify(received)}: expected three uppercase letters`,
    );
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`currency mismatch: expected ${expected}, got ${actual}`);
  }
}
