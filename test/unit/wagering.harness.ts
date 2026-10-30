import {
  ConsumeWagerMessageUseCase,
  OpenWalletUseCase,
  type SubmitWagerTransactionInput,
  type SubmitWagerTransactionResult,
  SubmitWagerTransactionUseCase,
  WagerTransactionApplier,
} from '@wagering/application';
import {
  Money,
  type WagerTransactionKind,
  type Wallet,
} from '@wagering/domain';
import {
  FakeClock,
  FakeInboxRepository,
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

export const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
export const OTHER_PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2';
export const PROVIDER = 'provider-a';
export const ROUND = 'round-987';
export const GAME = 'fortune-chimp';

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

export interface WageringHarness {
  submit: SubmitWagerTransactionUseCase;
  openWallet: OpenWalletUseCase;
  consume: ConsumeWagerMessageUseCase;
  wallets: FakeWalletRepository;
  accounts: FakeLedgerAccountRepository;
  ledger: FakeLedgerRepository;
  transactions: FakeWagerTransactionRepository;
  inbox: FakeInboxRepository;
  outbox: FakeOutboxRepository;
  metrics: FakeMetrics;
  clock: FakeClock;
  runner: PassthroughRunner;
  hasher: StubHasher;
}

export function buildWageringHarness(): WageringHarness {
  const wallets = new FakeWalletRepository();
  const accounts = new FakeLedgerAccountRepository();
  const ledger = new FakeLedgerRepository();
  const transactions = new FakeWagerTransactionRepository();
  const inbox = new FakeInboxRepository();
  const outbox = new FakeOutboxRepository();
  const metrics = new FakeMetrics();
  const clock = new FakeClock();
  const ids = new SequentialIds();
  const hasher = new StubHasher();
  const runner = new PassthroughRunner();

  const deps = {
    wallets,
    accounts,
    ledger,
    transactions,
    outbox,
    runner,
    clock,
    ids,
    hasher,
    metrics,
  };

  const applier = new WagerTransactionApplier(deps);
  const submit = new SubmitWagerTransactionUseCase({ ...deps, applier });

  return {
    submit,
    openWallet: new OpenWalletUseCase(deps),
    consume: new ConsumeWagerMessageUseCase({
      inbox,
      submit,
      runner,
      clock,
      hasher,
      metrics,
    }),
    wallets,
    accounts,
    ledger,
    transactions,
    inbox,
    outbox,
    metrics,
    clock,
    runner,
    hasher,
  };
}

export const openWallet = (
  h: WageringHarness,
  amount: string,
  playerId = PLAYER,
  currency = 'BRL',
): Promise<Wallet> =>
  h.openWallet.execute({
    playerId,
    initialBalance: { amount, currency },
    correlationId: 'corr-setup',
  });

let sequence = 0;

export function submitInput(
  overrides: Partial<SubmitWagerTransactionInput> & {
    walletId: string;
    kind: WagerTransactionKind;
    amount?: string;
  },
): SubmitWagerTransactionInput {
  sequence += 1;
  const externalTransactionId =
    overrides.externalTransactionId ?? `tx-${sequence}`;
  const providerId = overrides.providerId ?? PROVIDER;

  return {
    idempotencyKey:
      overrides.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
    providerId,
    externalTransactionId,
    playerId: overrides.playerId ?? PLAYER,
    walletId: overrides.walletId,
    roundId: overrides.roundId ?? ROUND,
    gameId: overrides.gameId ?? GAME,
    kind: overrides.kind,
    money: overrides.money ?? {
      amount: overrides.amount ?? '25.00',
      currency: 'BRL',
    },
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
    correlationId: overrides.correlationId ?? 'corr-1',
  };
}

export const eventTypes = (h: WageringHarness): string[] =>
  h.outbox.messages.map((message) => message.eventType);

/** Soma com sinal de todos os lançamentos: tem que fechar em zero. */
export const ledgerImbalance = (h: WageringHarness): string =>
  h.ledger.entries
    .reduce(
      (total, entry) => total.add(entry.signedAmount()),
      Money.zero('BRL'),
    )
    .toString();

export const resultOf = (result: SubmitWagerTransactionResult) => ({
  status: result.transaction.status,
  failureCode: result.transaction.failureCode,
  balance: result.balance.toString(),
  replay: result.idempotentReplay,
});
