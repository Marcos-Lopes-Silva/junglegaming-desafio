import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidCurrencyError,
  InvalidMoneyAmountError,
  Money,
} from '@wagering/domain';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from', () => {
  it('normaliza para escala fixa de 2 casas', () => {
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('25.5').toString()).toBe('25.50');
    expect(brl('25.50').toString()).toBe('25.50');
    expect(brl('0').toString()).toBe('0.00');
  });

  it.each([
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['notação científica', '1e3'],
    ['notação científica minúscula', '1.5e-3'],
    ['string vazia', ''],
    ['mais de 2 casas decimais', '1.234'],
    ['negativo', '-5.00'],
    ['sinal positivo explícito', '+5.00'],
    ['separador de milhar', '1,000.00'],
    ['espaço', ' 25.00'],
    ['só o ponto', '.'],
    ['sem parte inteira', '.50'],
    ['hexadecimal', '0x10'],
  ])('rejeita %s', (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyAmountError);
  });

  it('rejeita amount que não é string', () => {
    expect(() =>
      Money.from({ amount: 25 as unknown as string, currency: 'BRL' }),
    ).toThrow(InvalidMoneyAmountError);
  });

  it.each([['brl'], ['BRLL'], ['BR'], [''], ['R$ ']])(
    'rejeita a moeda %p',
    (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(
        InvalidCurrencyError,
      );
    },
  );

  it('nunca arredonda: mais de 2 casas é erro, não truncamento', () => {
    // Mais de 2 casas decimais é entrada inválida; truncar perderia centavos.
    expect(() => brl('10.999')).toThrow(InvalidMoneyAmountError);
    expect(() => brl('10.001')).toThrow(InvalidMoneyAmountError);
  });
});

describe('aritmética', () => {
  it('soma e subtrai com exatidão decimal', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(brl('1000.00').subtract(brl('999.99')).toString()).toBe('0.01');
  });

  it('é imutável: operações devolvem nova instância', () => {
    const original = brl('100.00');
    const result = original.add(brl('50.00'));

    expect(original.toString()).toBe('100.00');
    expect(result.toString()).toBe('150.00');
    expect(result).not.toBe(original);
  });

  it('permite negativo por subtração, mas não por contrato de entrada', () => {
    const negative = brl('10.00').subtract(brl('30.00'));

    expect(negative.isNegative()).toBe(true);
    expect(negative.toString()).toBe('-20.00');
    expect(() => brl('-20.00')).toThrow(InvalidMoneyAmountError);
  });

  it('negate inverte o sinal', () => {
    expect(brl('25.00').negate().toString()).toBe('-25.00');
    expect(brl('0.00').negate().isZero()).toBe(true);
  });

  it('acumula sem erro de ponto flutuante', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i += 1) {
      total = total.add(brl('0.01'));
    }
    expect(total.toString()).toBe('10.00');
  });
});

describe('conflito de moeda', () => {
  const real = brl('10.00');
  const dollar = Money.from({ amount: '10.00', currency: 'USD' });

  it.each([
    ['add', () => real.add(dollar)],
    ['subtract', () => real.subtract(dollar)],
    ['isLessThan', () => real.isLessThan(dollar)],
  ])(
    '%s entre moedas diferentes lança erro de domínio',
    (_label, operation) => {
      expect(operation).toThrow(CurrencyMismatchError);
    },
  );

  it('equals entre moedas diferentes é falso, não erro', () => {
    expect(real.equals(dollar)).toBe(false);
  });
});

describe('comparações e serialização', () => {
  it('isZero, isPositive, isNegative', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('1.00').subtract(brl('2.00')).isNegative()).toBe(true);
  });

  it('isLessThan compara valores', () => {
    expect(brl('9.99').isLessThan(brl('10.00'))).toBe(true);
    expect(brl('10.00').isLessThan(brl('10.00'))).toBe(false);
  });

  it('toJSON devolve amount com escala fixa e a moeda', () => {
    expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('rehydrate aceita negativo vindo da persistência', () => {
    expect(
      Money.rehydrate({ amount: '-20.00', currency: 'BRL' }).toString(),
    ).toBe('-20.00');
  });
});
