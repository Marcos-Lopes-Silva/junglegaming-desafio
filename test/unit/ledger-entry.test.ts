import { describe, expect, it } from 'bun:test';
import {
  InvalidLedgerEntryAmountError,
  LedgerAccount,
  LedgerAccountKind,
  LedgerDirection,
  Money,
  UnbalancedLedgerEntryError,
  WalletLedgerEntry,
} from '@wagering/domain';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const AT = new Date('2026-07-29T15:00:00.000Z');

const base = {
  id: 'e1',
  accountId: 'a1',
  transactionId: 't1',
  createdAt: AT,
};

describe('WalletLedgerEntry.create', () => {
  it('aceita crédito com aritmética correta', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('125.00'),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  it('aceita débito com aritmética correta', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  it('rejeita aritmética inconsistente', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('124.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('rejeita direção trocada', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('125.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it.each([['0.00'], ['0']])('rejeita valor não positivo (%p)', (amount) => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl(amount),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('100.00'),
      }),
    ).toThrow(InvalidLedgerEntryAmountError);
  });

  it('aceita contrapartida sem saldo materializado', () => {
    // Contas de sistema não materializam saldo, para não virarem linha quente
    // travada por todas as wallets.
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: undefined,
      balanceAfter: undefined,
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceBefore).toBeUndefined();
  });

  it('rejeita saldo pela metade', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: undefined,
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });
});

describe('imutabilidade estrutural', () => {
  it('não expõe setters nem métodos de transição', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('25.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('25.00'),
    });

    expect(Object.isFrozen(entry)).toBe(true);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry));
    expect(methods).toEqual(
      expect.arrayContaining(['isBalanced', 'signedAmount']),
    );
    expect(methods).not.toEqual(
      expect.arrayContaining(['markProcessed', 'reject']),
    );
  });
});

describe('signedAmount', () => {
  it('crédito é positivo e débito é negativo', () => {
    const credit = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('25.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('25.00'),
    });
    const debit = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('25.00'),
      balanceAfter: brl('0.00'),
    });

    expect(credit.signedAmount().toString()).toBe('25.00');
    expect(debit.signedAmount().toString()).toBe('-25.00');
  });
});

describe('LedgerAccount', () => {
  it('conta de jogador materializa saldo', () => {
    const account = LedgerAccount.openForWallet({
      id: 'a1',
      walletId: 'w1',
      currency: 'BRL',
      at: AT,
    });

    expect(account.kind).toBe(LedgerAccountKind.PlayerWallet);
    expect(account.tracksBalance()).toBe(true);
  });

  const systemKinds = [
    LedgerAccountKind.HouseWagering,
    LedgerAccountKind.ExternalFunding,
  ] as const;

  it.each(systemKinds)('conta de sistema %s não materializa saldo', (kind) => {
    const account = LedgerAccount.openSystemAccount({
      id: 'a2',
      kind,
      currency: 'BRL',
      at: AT,
    });

    expect(account.walletId).toBeUndefined();
    expect(account.tracksBalance()).toBe(false);
  });
});
