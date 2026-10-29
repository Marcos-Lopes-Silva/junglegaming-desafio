import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  LedgerDirection,
  Money,
  Wallet,
} from '@wagering/domain';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const AT = new Date('2026-07-29T15:00:00.000Z');
const LATER = new Date('2026-07-29T15:05:00.000Z');

const openWith = (amount: string) =>
  Wallet.open({
    id: '0192f291-27dd-7d3f-8071-5f8685deef37',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    initialBalance: brl(amount),
    at: AT,
  });

describe('Wallet.open', () => {
  it('nasce em version 1 com o saldo inicial aplicado', () => {
    // O crédito de abertura é parte da criação, não uma alteração posterior.
    const { wallet } = openWith('1000.00');

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('1000.00');
  });

  it('deriva a moeda do saldo inicial', () => {
    const { wallet } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: Money.from({ amount: '10.00', currency: 'USD' }),
      at: AT,
    });

    expect(wallet.currency).toBe('USD');
  });

  it('com saldo inicial devolve o crédito de abertura', () => {
    const { openingChange } = openWith('1000.00');

    expect(openingChange).toBeDefined();
    expect(openingChange?.direction).toBe(LedgerDirection.Credit);
    expect(openingChange?.balanceBefore.toString()).toBe('0.00');
    expect(openingChange?.balanceAfter.toString()).toBe('1000.00');
    expect(openingChange?.walletVersion).toBe(1);
  });

  it('com saldo zero não gera crédito de abertura', () => {
    const { wallet, openingChange } = openWith('0.00');

    expect(openingChange).toBeUndefined();
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });
});

describe('débito', () => {
  it('reduz o saldo e incrementa a version', () => {
    const { wallet } = openWith('100.00');
    const change = wallet.debit(brl('25.00'), LATER);

    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toBe(LATER);
    expect(change.direction).toBe(LedgerDirection.Debit);
    expect(change.balanceBefore.toString()).toBe('100.00');
    expect(change.balanceAfter.toString()).toBe('75.00');
  });

  it('permite zerar o saldo', () => {
    const { wallet } = openWith('80.00');
    wallet.debit(brl('80.00'), LATER);

    expect(wallet.balance.toString()).toBe('0.00');
  });

  it('rejeita débito que deixaria o saldo negativo', () => {
    const { wallet } = openWith('100.00');

    expect(() => wallet.debit(brl('100.01'), LATER)).toThrow(
      InsufficientFundsError,
    );
  });

  it('não altera estado algum quando rejeita', () => {
    const { wallet } = openWith('100.00');

    expect(() => wallet.debit(brl('200.00'), LATER)).toThrow(
      InsufficientFundsError,
    );
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toBe(AT);
  });

  it('carrega disponível e solicitado no erro', () => {
    const { wallet } = openWith('30.00');

    try {
      wallet.debit(brl('80.00'), LATER);
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientFundsError);
      const insufficient = error as InsufficientFundsError;
      expect(insufficient.available.toString()).toBe('30.00');
      expect(insufficient.requested.toString()).toBe('80.00');
    }
  });
});

describe('crédito', () => {
  it('aumenta o saldo e incrementa a version', () => {
    const { wallet } = openWith('100.00');
    const change = wallet.credit(brl('50.00'), LATER);

    expect(wallet.balance.toString()).toBe('150.00');
    expect(wallet.version).toBe(2);
    expect(change.direction).toBe(LedgerDirection.Credit);
  });

  it('version acompanha cada movimentação', () => {
    const { wallet } = openWith('100.00');

    wallet.credit(brl('10.00'), LATER);
    wallet.debit(brl('5.00'), LATER);
    wallet.credit(brl('1.00'), LATER);

    expect(wallet.version).toBe(4);
    expect(wallet.balance.toString()).toBe('106.00');
  });
});

describe('conflito de moeda', () => {
  it('recusa movimentação em moeda diferente da wallet', () => {
    const { wallet } = openWith('100.00');
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => wallet.debit(usd, LATER)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd, LATER)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });
});

describe('rehydrate', () => {
  it('reconstrói o estado sem revalidar transições', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: { amount: '42.00', currency: 'BRL' },
      version: 17,
      createdAt: AT,
      updatedAt: LATER,
    });

    expect(wallet.balance.toString()).toBe('42.00');
    expect(wallet.version).toBe(17);
  });

  it('continua aplicando as regras às movimentações seguintes', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: { amount: '10.00', currency: 'BRL' },
      version: 3,
      createdAt: AT,
      updatedAt: AT,
    });

    expect(() => wallet.debit(brl('11.00'), LATER)).toThrow(
      InsufficientFundsError,
    );
  });
});
