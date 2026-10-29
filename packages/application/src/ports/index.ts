import type {
  InboxMessage,
  LedgerAccount,
  LedgerAccountKind,
  Money,
  OutboxMessage,
  WagerTransaction,
  Wallet,
  WalletLedgerEntry,
} from '@wagering/domain';

/**
 * Tokens de injeção dos ports. Interfaces não existem em runtime, então a DI
 * precisa de um símbolo, e `packages/application` fica sem decorators.
 */
export const WALLET_REPOSITORY = Symbol('WalletRepository');
export const LEDGER_REPOSITORY = Symbol('LedgerRepository');
export const LEDGER_ACCOUNT_REPOSITORY = Symbol('LedgerAccountRepository');
export const WAGER_TRANSACTION_REPOSITORY = Symbol(
  'WagerTransactionRepository',
);
export const INBOX_REPOSITORY = Symbol('InboxRepository');
export const OUTBOX_REPOSITORY = Symbol('OutboxRepository');
export const EVENT_PUBLISHER = Symbol('EventPublisher');
export const TRANSACTION_RUNNER = Symbol('TransactionRunner');
export const CLOCK = Symbol('Clock');
export const ID_GENERATOR = Symbol('IdGenerator');
export const METRICS = Symbol('Metrics');
export const PAYLOAD_HASHER = Symbol('PayloadHasher');
export const PROVIDER_IDENTITY = Symbol('ProviderIdentity');

export interface ClockPort {
  now(): Date;
}

export interface IdGeneratorPort {
  /** UUIDv7: ordenável por tempo, o que o cursor do ledger aproveita. */
  next(): string;
}

export interface PayloadHasherPort {
  /** SHA-256 hex sobre JSON canônico de chaves ordenadas. */
  hash(payload: Record<string, unknown>): string;
}

/**
 * Executa o callback numa única transação de banco. Os repositórios se juntam
 * a ela pelo contexto da implementação, sem transação passada como parâmetro.
 */
export interface TransactionRunnerPort {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export interface WalletRepositoryPort {
  findById(walletId: string): Promise<Wallet | undefined>;
  /** `SELECT ... FOR UPDATE`: a unidade de concorrência é a walletId. */
  lockById(walletId: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  update(wallet: Wallet): Promise<void>;
}

export interface LedgerAccountRepositoryPort {
  insert(account: LedgerAccount): Promise<void>;
  findForWallet(walletId: string): Promise<LedgerAccount | undefined>;
  /** Resolve (criando na primeira vez) a conta de sistema da moeda. */
  resolveSystemAccount(
    kind: LedgerAccountKind.HouseWagering | LedgerAccountKind.ExternalFunding,
    currency: string,
  ): Promise<LedgerAccount>;
}

export interface LedgerCursor {
  createdAt: Date;
  id: string;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor: LedgerCursor | undefined;
}

export interface LedgerAggregate {
  signedSum: Money;
  count: number;
}

export interface LedgerRepositoryPort {
  insertMany(entries: WalletLedgerEntry[]): Promise<void>;
  listByAccount(
    accountId: string,
    limit: number,
    cursor: LedgerCursor | undefined,
  ): Promise<LedgerPage>;
  /** Soma com sinal e contagem, base da reconciliação. */
  aggregateByAccount(
    accountId: string,
    currency: string,
  ): Promise<LedgerAggregate>;
}

export interface WagerTransactionRepositoryPort {
  insert(transaction: WagerTransaction): Promise<void>;
  /**
   * `INSERT ... ON CONFLICT DO NOTHING`: devolve `false` quando a transação já
   * existia. Uma unique violation abortaria a transação SQL inteira, e com ela o
   * lock da wallet e qualquer registro de auditoria.
   */
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;
  update(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  /** `SELECT ... FOR UPDATE`, usado no reprocessamento após travar a wallet. */
  lockById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Já existe reversão `PROCESSED` apontando para esta referência. */
  hasProcessedReversalFor(referenceTransactionId: string): Promise<boolean>;
  /**
   * Ids de `PENDING_REFERENCE` vencidas, sem lock.
   *
   * Quem reprocessa precisa travar a wallet antes da transação, na mesma ordem
   * da submissão. Travar a transação aqui inverteria essa ordem e poderia
   * causar deadlock.
   */
  findDuePendingReferenceIds(limit: number, now: Date): Promise<string[]>;
}

export interface InboxRepositoryPort {
  /**
   * Devolve `false` se a mensagem já havia sido processada. Registro e efeitos
   * financeiros commitam juntos, então a linha existir já significa "processada".
   */
  receiveIfAbsent(message: InboxMessage): Promise<boolean>;
  findOne(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined>;
}

export interface OutboxRepositoryPort {
  insertMany(messages: OutboxMessage[]): Promise<void>;
  /**
   * `FOR UPDATE SKIP LOCKED` permite vários publishers concorrentes sem lock
   * global: cada um pega um lote diferente.
   */
  claimDue(limit: number, now: Date): Promise<OutboxMessage[]>;
  markPublished(message: OutboxMessage): Promise<void>;
  scheduleRetry(message: OutboxMessage): Promise<void>;
  /** Idade da mensagem pendente mais antiga, em segundos: o outbox lag. */
  oldestPendingAgeSeconds(now: Date): Promise<number>;
}

/** Publicação no broker, sempre depois do commit. */
export interface EventPublisherPort {
  publish(message: OutboxMessage): Promise<void>;
}

export interface MetricsPort {
  recordReconciliation(consistent: boolean): void;
  recordWalletOpened(): void;
  recordTransaction(status: string, kind: string): void;
  recordIdempotentReplay(): void;
  recordIdempotencyConflict(): void;
  /** Mensagem já processada, barrada pelo inbox. */
  recordInboxDuplicate(): void;
  recordRetry(stage: string): void;
  recordDlqMessage(reason: string): void;
  recordOutboxLag(seconds: number): void;
  observeProcessingLatency(source: string, seconds: number): void;
}

/**
 * Ponto de extensão da autenticação, não implementada. A implementação
 * atual confia no `providerId` do payload; uma OIDC derivaria a identidade do
 * token e rejeitaria divergência.
 */
export interface ProviderIdentityPort {
  resolve(claimedProviderId: string): Promise<string>;
}
