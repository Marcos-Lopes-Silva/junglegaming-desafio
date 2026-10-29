import { Decimal } from 'decimal.js';
import {
  CurrencyMismatchError,
  InvalidCurrencyError,
  InvalidMoneyAmountError,
} from './money.errors.js';

export interface MoneyProps {
  /** decimal string, ex.: "25.00" */
  amount: string;
  /** ISO-4217 */
  currency: string;
}

export const MONEY_SCALE = 2;

/**
 * Aceita apenas decimal simples, sem sinal e com no máximo 2 casas. A validação
 * do Decimal não serviria: `new Decimal("1e3")` é válido para ele.
 */
const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável. `from` é o contrato de entrada e rejeita
 * negativos; a aritmética interna (`subtract`, `negate`) pode produzir
 * negativos legítimos.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Contrato de entrada: string decimal, escala ≤ 2, não negativa. */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props;

    if (typeof amount !== 'string') {
      throw new InvalidMoneyAmountError(amount, 'expected a decimal string');
    }
    if (amount.length === 0) {
      throw new InvalidMoneyAmountError(amount, 'empty string');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyAmountError(
        amount,
        `expected a non-negative decimal string with at most ${MONEY_SCALE} decimal places`,
      );
    }

    return new Money(new Decimal(amount), Money.assertCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), Money.assertCurrency(currency));
  }

  /**
   * Reconstrução interna usada pela aritmética, sem o contrato de entrada:
   * o resultado de uma operação pode ser negativo.
   */
  private static of(value: Decimal, currency: string): Money {
    return new Money(value, currency);
  }

  /** Reidratação a partir da persistência, sem a regra de não-negatividade. */
  static rehydrate(props: MoneyProps): Money {
    if (
      typeof props.amount !== 'string' ||
      !/^-?\d+(\.\d{1,2})?$/.test(props.amount)
    ) {
      throw new InvalidMoneyAmountError(
        props.amount,
        'corrupted persisted amount',
      );
    }
    return new Money(
      new Decimal(props.amount),
      Money.assertCurrency(props.currency),
    );
  }

  private static assertCurrency(currency: string): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidCurrencyError(currency);
    }
    return currency;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  /** Sempre com escala fixa de 2 casas. */
  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(MONEY_SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
