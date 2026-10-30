import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { Global, Module, type Provider } from '@nestjs/common';
import {
  CLOCK,
  ConsumeWagerMessageUseCase,
  GetWagerTransactionByExternalIdUseCase,
  GetWagerTransactionUseCase,
  GetWalletUseCase,
  ID_GENERATOR,
  INBOX_REPOSITORY,
  LEDGER_ACCOUNT_REPOSITORY,
  LEDGER_REPOSITORY,
  ListWalletLedgerUseCase,
  METRICS,
  OUTBOX_REPOSITORY,
  OpenWalletUseCase,
  PAYLOAD_HASHER,
  PROVIDER_IDENTITY,
  ReconcileWalletUseCase,
  SubmitWagerTransactionUseCase,
  TRANSACTION_RUNNER,
  WAGER_TRANSACTION_REPOSITORY,
  WALLET_REPOSITORY,
  WagerTransactionApplier,
  type ClockPort,
  type IdGeneratorPort,
  type InboxRepositoryPort,
  type LedgerAccountRepositoryPort,
  type LedgerRepositoryPort,
  type MetricsPort,
  type OutboxRepositoryPort,
  type PayloadHasherPort,
  type TransactionRunnerPort,
  type WagerTransactionRepositoryPort,
  type WalletRepositoryPort,
} from '@wagering/application';
import {
  InboxRepository,
  LedgerAccountRepository,
  LedgerRepository,
  OutboxRepository,
  Sha256PayloadHasher,
  SqsGateway,
  SystemClock,
  TransactionRunner,
  TrustedPayloadProviderIdentity,
  Uuidv7Generator,
  WagerTransactionRepository,
  WalletRepository,
  buildOrmConfig,
  readDatabaseOptions,
  readSqsOptions,
} from '@wagering/infrastructure';
import { NoopMetrics } from './noop-metrics.js';

/**
 * Interfaces não existem em runtime, então cada port é registrado com um token
 * e uma factory. Assim `packages/application` não depende de decorators do
 * Nest.
 */
const adapters: Provider[] = [
  { provide: CLOCK, useClass: SystemClock },
  { provide: ID_GENERATOR, useClass: Uuidv7Generator },
  { provide: PAYLOAD_HASHER, useClass: Sha256PayloadHasher },
  { provide: METRICS, useClass: NoopMetrics },
  { provide: PROVIDER_IDENTITY, useClass: TrustedPayloadProviderIdentity },
  { provide: SqsGateway, useFactory: () => new SqsGateway(readSqsOptions()) },
  {
    provide: TRANSACTION_RUNNER,
    useFactory: (em: EntityManager) => new TransactionRunner(em),
    inject: [EntityManager],
  },
  {
    provide: WALLET_REPOSITORY,
    useFactory: (em: EntityManager) => new WalletRepository(em),
    inject: [EntityManager],
  },
  {
    provide: LEDGER_ACCOUNT_REPOSITORY,
    useFactory: (em: EntityManager) => new LedgerAccountRepository(em),
    inject: [EntityManager],
  },
  {
    provide: LEDGER_REPOSITORY,
    useFactory: (em: EntityManager) => new LedgerRepository(em),
    inject: [EntityManager],
  },
  {
    provide: WAGER_TRANSACTION_REPOSITORY,
    useFactory: (em: EntityManager) => new WagerTransactionRepository(em),
    inject: [EntityManager],
  },
  {
    provide: INBOX_REPOSITORY,
    useFactory: (em: EntityManager) => new InboxRepository(em),
    inject: [EntityManager],
  },
  {
    provide: OUTBOX_REPOSITORY,
    useFactory: (em: EntityManager) => new OutboxRepository(em),
    inject: [EntityManager],
  },
];

const useCases: Provider[] = [
  {
    provide: OpenWalletUseCase,
    useFactory: (
      wallets: WalletRepositoryPort,
      accounts: LedgerAccountRepositoryPort,
      ledger: LedgerRepositoryPort,
      transactions: WagerTransactionRepositoryPort,
      outbox: OutboxRepositoryPort,
      runner: TransactionRunnerPort,
      clock: ClockPort,
      ids: IdGeneratorPort,
      hasher: PayloadHasherPort,
      metrics: MetricsPort,
    ) =>
      new OpenWalletUseCase({
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
      }),
    inject: [
      WALLET_REPOSITORY,
      LEDGER_ACCOUNT_REPOSITORY,
      LEDGER_REPOSITORY,
      WAGER_TRANSACTION_REPOSITORY,
      OUTBOX_REPOSITORY,
      TRANSACTION_RUNNER,
      CLOCK,
      ID_GENERATOR,
      PAYLOAD_HASHER,
      METRICS,
    ],
  },
  {
    provide: GetWalletUseCase,
    useFactory: (wallets: WalletRepositoryPort) =>
      new GetWalletUseCase(wallets),
    inject: [WALLET_REPOSITORY],
  },
  {
    provide: ListWalletLedgerUseCase,
    useFactory: (
      wallets: WalletRepositoryPort,
      accounts: LedgerAccountRepositoryPort,
      ledger: LedgerRepositoryPort,
    ) => new ListWalletLedgerUseCase(wallets, accounts, ledger),
    inject: [WALLET_REPOSITORY, LEDGER_ACCOUNT_REPOSITORY, LEDGER_REPOSITORY],
  },
  {
    provide: ReconcileWalletUseCase,
    useFactory: (
      wallets: WalletRepositoryPort,
      accounts: LedgerAccountRepositoryPort,
      ledger: LedgerRepositoryPort,
      metrics: MetricsPort,
    ) => new ReconcileWalletUseCase(wallets, accounts, ledger, metrics),
    inject: [
      WALLET_REPOSITORY,
      LEDGER_ACCOUNT_REPOSITORY,
      LEDGER_REPOSITORY,
      METRICS,
    ],
  },
  {
    provide: WagerTransactionApplier,
    useFactory: (
      wallets: WalletRepositoryPort,
      accounts: LedgerAccountRepositoryPort,
      ledger: LedgerRepositoryPort,
      transactions: WagerTransactionRepositoryPort,
      outbox: OutboxRepositoryPort,
      ids: IdGeneratorPort,
      metrics: MetricsPort,
    ) =>
      new WagerTransactionApplier({
        wallets,
        accounts,
        ledger,
        transactions,
        outbox,
        ids,
        metrics,
      }),
    inject: [
      WALLET_REPOSITORY,
      LEDGER_ACCOUNT_REPOSITORY,
      LEDGER_REPOSITORY,
      WAGER_TRANSACTION_REPOSITORY,
      OUTBOX_REPOSITORY,
      ID_GENERATOR,
      METRICS,
    ],
  },
  {
    provide: SubmitWagerTransactionUseCase,
    useFactory: (
      wallets: WalletRepositoryPort,
      transactions: WagerTransactionRepositoryPort,
      applier: WagerTransactionApplier,
      runner: TransactionRunnerPort,
      clock: ClockPort,
      ids: IdGeneratorPort,
      hasher: PayloadHasherPort,
      metrics: MetricsPort,
    ) =>
      new SubmitWagerTransactionUseCase({
        wallets,
        transactions,
        applier,
        runner,
        clock,
        ids,
        hasher,
        metrics,
      }),
    inject: [
      WALLET_REPOSITORY,
      WAGER_TRANSACTION_REPOSITORY,
      WagerTransactionApplier,
      TRANSACTION_RUNNER,
      CLOCK,
      ID_GENERATOR,
      PAYLOAD_HASHER,
      METRICS,
    ],
  },
  {
    provide: GetWagerTransactionUseCase,
    useFactory: (transactions: WagerTransactionRepositoryPort) =>
      new GetWagerTransactionUseCase(transactions),
    inject: [WAGER_TRANSACTION_REPOSITORY],
  },
  {
    provide: GetWagerTransactionByExternalIdUseCase,
    useFactory: (transactions: WagerTransactionRepositoryPort) =>
      new GetWagerTransactionByExternalIdUseCase(transactions),
    inject: [WAGER_TRANSACTION_REPOSITORY],
  },
  {
    provide: ConsumeWagerMessageUseCase,
    useFactory: (
      inbox: InboxRepositoryPort,
      submit: SubmitWagerTransactionUseCase,
      runner: TransactionRunnerPort,
      clock: ClockPort,
      hasher: PayloadHasherPort,
      metrics: MetricsPort,
    ) =>
      new ConsumeWagerMessageUseCase({
        inbox,
        submit,
        runner,
        clock,
        hasher,
        metrics,
      }),
    inject: [
      INBOX_REPOSITORY,
      SubmitWagerTransactionUseCase,
      TRANSACTION_RUNNER,
      CLOCK,
      PAYLOAD_HASHER,
      METRICS,
    ],
  },
];

/**
 * Módulo usado pela API e pelo worker, para que os dois montem os mesmos
 * adaptadores e casos de uso.
 */
@Global()
@Module({
  imports: [MikroOrmModule.forRoot(buildOrmConfig(readDatabaseOptions()))],
  providers: [...adapters, ...useCases],
  exports: [
    ...adapters.map((provider) => (provider as { provide: unknown }).provide),
    ...useCases.map((provider) => (provider as { provide: unknown }).provide),
  ] as never[],
})
export class CoreModule {}
