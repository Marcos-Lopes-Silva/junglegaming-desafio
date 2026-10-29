import { beforeEach, describe, expect, it } from 'bun:test';
import {
  OpenWalletUseCase,
  ReconcileWalletUseCase,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '@wagering/application';
import {
  InvalidMoneyAmountError,
  LedgerAccountKind,
  LedgerDirection,
  Money,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@wagering/domain';
import {
  FakeClock,
  FakeLedgerAccountRepository,
  FakeLedgerRepository,
  FakeMetrics,
  FakeOutboxRepository,
  FakeWagerTransactionRepository,
  FakeWalletRepository,
  PassthroughRunner,
  SequentialIds,
  StubHasher,
} from './fakes.js';

const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

function build() {
  const wallets = new FakeWalletRepository();
  const accounts = new FakeLedgerAccountRepository();
  const ledger = new FakeLedgerRepository();
  const transactions = new FakeWagerTransactionRepository();
  const outbox = new FakeOutboxRepository();
  const runner = new PassthroughRunner();
  const metrics = new FakeMetrics();

  const useCase = new OpenWalletUseCase({
    wallets,
    accounts,
    ledger,
    transactions,
    outbox,
    runner,
    clock: new FakeClock(),
    ids: new SequentialIds(),
    hasher: new StubHasher(),
    metrics,
  });

  const reconcile = new ReconcileWalletUseCase(
    wallets,
    accounts,
    ledger,
    metrics,
  );

  return {
    useCase,
    reconcile,
    wallets,
    accounts,
    ledger,
    transactions,
    outbox,
    runner,
    metrics,
  };
}

describe('OpenWalletUseCase com saldo inicial', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(async () => {
    ctx = build();
    await ctx.useCase.execute({
      playerId: PLAYER,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
      correlationId: 'corr-1',
    });
  });

  it('cria a wallet em version 1 com o saldo aplicado', () => {
    const [wallet] = [...ctx.wallets.wallets.values()];

    expect(wallet?.balance.toString()).toBe('1000.00');
    expect(wallet?.version).toBe(1);
  });

  it('roda tudo dentro de uma única transação', () => {
    expect(ctx.runner.calls).toBe(1);
  });

  it('gera a transação interna OPENING já processada', () => {
    expect(ctx.transactions.transactions).toHaveLength(1);
    const [transaction] = ctx.transactions.transactions;

    expect(transaction?.kind).toBe(WagerTransactionKind.Opening);
    expect(transaction?.status).toBe(WagerTransactionStatus.Processed);
  });

  it('lança o par de partidas dobradas', () => {
    expect(ctx.ledger.entries).toHaveLength(2);

    const credit = ctx.ledger.entries.find(
      (e) => e.direction === LedgerDirection.Credit,
    );
    const debit = ctx.ledger.entries.find(
      (e) => e.direction === LedgerDirection.Debit,
    );

    expect(credit?.balanceBefore?.toString()).toBe('0.00');
    expect(credit?.balanceAfter?.toString()).toBe('1000.00');
    // A contrapartida não materializa saldo.
    expect(debit?.balanceBefore).toBeUndefined();
  });

  it('os lançamentos da transação somam zero', () => {
    const total = ctx.ledger.entries.reduce(
      (sum, entry) => sum.add(entry.signedAmount()),
      Money.zero('BRL'),
    );

    expect(total.toString()).toBe('0.00');
  });

  it('credita a wallet e debita a conta de funding', () => {
    const walletAccount = ctx.accounts.accounts.find(
      (a) => a.kind === LedgerAccountKind.PlayerWallet,
    );
    const funding = ctx.accounts.accounts.find(
      (a) => a.kind === LedgerAccountKind.ExternalFunding,
    );

    const credit = ctx.ledger.entries.find(
      (e) => e.direction === LedgerDirection.Credit,
    );
    const debit = ctx.ledger.entries.find(
      (e) => e.direction === LedgerDirection.Debit,
    );

    expect(credit?.accountId).toBe(walletAccount?.id ?? '');
    expect(debit?.accountId).toBe(funding?.id ?? '');
  });

  it('enfileira WalletBalanceChanged na outbox', () => {
    expect(ctx.outbox.messages).toHaveLength(1);
    const [message] = ctx.outbox.messages;

    expect(message?.eventType).toBe('WalletBalanceChanged');
    expect(message?.isPending()).toBe(true);
    expect(message?.payload).toMatchObject({
      eventType: 'WalletBalanceChanged',
      correlationId: 'corr-1',
      version: 1,
    });
  });

  it('o payload do evento carrega string decimal, não instância de Money', () => {
    const payload = ctx.outbox.messages[0]?.payload as {
      data: Record<string, unknown>;
    };

    expect(payload.data.money).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(payload.data.balanceAfter).toEqual({
      amount: '1000.00',
      currency: 'BRL',
    });
  });
});

describe('OpenWalletUseCase com saldo zero', () => {
  it('não gera transação, lançamento nem evento', async () => {
    const ctx = build();

    await ctx.useCase.execute({
      playerId: PLAYER,
      initialBalance: { amount: '0.00', currency: 'BRL' },
      correlationId: 'corr-2',
    });

    expect(ctx.transactions.transactions).toHaveLength(0);
    expect(ctx.ledger.entries).toHaveLength(0);
    expect(ctx.outbox.messages).toHaveLength(0);
    expect(ctx.accounts.accounts).toHaveLength(1);
  });
});

describe('OpenWalletUseCase: validações', () => {
  it('propaga wallet duplicada como conflito', async () => {
    const ctx = build();
    const input = {
      playerId: PLAYER,
      initialBalance: { amount: '10.00', currency: 'BRL' },
      correlationId: 'corr-3',
    };

    await ctx.useCase.execute(input);

    const error = await ctx.useCase.execute(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WalletAlreadyExistsError);
  });

  it('permite o mesmo player em moedas diferentes', async () => {
    const ctx = build();

    await ctx.useCase.execute({
      playerId: PLAYER,
      initialBalance: { amount: '10.00', currency: 'BRL' },
      correlationId: 'c',
    });
    await ctx.useCase.execute({
      playerId: PLAYER,
      initialBalance: { amount: '10.00', currency: 'USD' },
      correlationId: 'c',
    });

    expect(ctx.wallets.wallets.size).toBe(2);
  });

  it('rejeita saldo inicial inválido antes de abrir transação', async () => {
    const ctx = build();

    const error = await ctx.useCase
      .execute({
        playerId: PLAYER,
        initialBalance: { amount: '10.999', currency: 'BRL' },
        correlationId: 'c',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidMoneyAmountError);

    expect(ctx.runner.calls).toBe(0);
  });
});

describe('ReconcileWalletUseCase', () => {
  it('confirma consistência entre saldo e ledger', async () => {
    const ctx = build();
    const wallet = await ctx.useCase.execute({
      playerId: PLAYER,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
      correlationId: 'c',
    });

    const result = await ctx.reconcile.execute(wallet.id);

    expect(result.consistent).toBe(true);
    expect(result.storedBalance.toString()).toBe('1000.00');
    expect(result.calculatedBalance.toString()).toBe('1000.00');
    expect(result.difference.toString()).toBe('0.00');
    expect(result.checkedEntries).toBe(1);
    expect(ctx.metrics.reconciliations).toEqual([true]);
  });

  it('sinaliza divergência sem corrigir o saldo', async () => {
    const ctx = build();
    const wallet = await ctx.useCase.execute({
      playerId: PLAYER,
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: 'c',
    });

    wallet.credit(Money.from({ amount: '50.00', currency: 'BRL' }), new Date());
    await ctx.wallets.update(wallet);

    const result = await ctx.reconcile.execute(wallet.id);

    expect(result.consistent).toBe(false);
    expect(result.difference.toString()).toBe('50.00');
    expect(ctx.metrics.reconciliations).toEqual([false]);
    // O saldo não foi corrigido.
    expect(wallet.balance.toString()).toBe('150.00');
  });

  it('lança WalletNotFoundError para wallet inexistente', async () => {
    const ctx = build();

    const error = await ctx.reconcile
      .execute('00000000-0000-7000-8000-999999999999')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WalletNotFoundError);
  });
});
