import {
  type ClockPort,
  type EventPublisherPort,
  type IdGeneratorPort,
  type InboxRepositoryPort,
  type LedgerAccountRepositoryPort,
  type LedgerAggregate,
  type LedgerCursor,
  type LedgerPage,
  type LedgerRepositoryPort,
  type MetricsPort,
  type OutboxRepositoryPort,
  type PayloadHasherPort,
  type TransactionRunnerPort,
  type WagerTransactionRepositoryPort,
  WalletAlreadyExistsError,
  type WalletRepositoryPort,
} from '@wagering/application';
import {
  type InboxMessage,
  LedgerAccount,
  type LedgerAccountKind,
  Money,
  type OutboxMessage,
  type WagerTransaction,
  WagerTransactionStatus,
  type Wallet,
  type WalletLedgerEntry,
} from '@wagering/domain';

/**
 * Dublês em memória: o alvo aqui é só a orquestração do caso de uso, não a
 * persistência nem a mensageria reais.
 */

export class FakeClock implements ClockPort {
  constructor(private current = new Date('2026-07-29T15:00:00.000Z')) {}

  now(): Date {
    return this.current;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequentialIds implements IdGeneratorPort {
  private counter = 0;
  readonly issued: string[] = [];

  next(): string {
    this.counter += 1;
    const id = `00000000-0000-7000-8000-${String(this.counter).padStart(12, '0')}`;
    this.issued.push(id);
    return id;
  }
}

export class StubHasher implements PayloadHasherPort {
  hash(payload: Record<string, unknown>): string {
    return `hash:${JSON.stringify(payload)}`;
  }
}

/** Executa o callback direto: a atomicidade real não é exercitada aqui. */
export class PassthroughRunner implements TransactionRunnerPort {
  calls = 0;

  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.calls += 1;
    return fn();
  }
}

export class FakeWalletRepository implements WalletRepositoryPort {
  readonly wallets = new Map<string, Wallet>();

  findById(walletId: string): Promise<Wallet | undefined> {
    return Promise.resolve(this.wallets.get(walletId));
  }

  lockById(walletId: string): Promise<Wallet | undefined> {
    return Promise.resolve(this.wallets.get(walletId));
  }

  insert(wallet: Wallet): Promise<void> {
    const duplicate = [...this.wallets.values()].some(
      (existing) =>
        existing.playerId === wallet.playerId &&
        existing.currency === wallet.currency,
    );
    if (duplicate) {
      return Promise.reject(
        new WalletAlreadyExistsError(wallet.playerId, wallet.currency),
      );
    }
    this.wallets.set(wallet.id, wallet);
    return Promise.resolve();
  }

  update(wallet: Wallet): Promise<void> {
    this.wallets.set(wallet.id, wallet);
    return Promise.resolve();
  }
}

export class FakeLedgerAccountRepository implements LedgerAccountRepositoryPort {
  readonly accounts: LedgerAccount[] = [];
  private systemCounter = 0;

  insert(account: LedgerAccount): Promise<void> {
    this.accounts.push(account);
    return Promise.resolve();
  }

  findForWallet(walletId: string): Promise<LedgerAccount | undefined> {
    return Promise.resolve(
      this.accounts.find((account) => account.walletId === walletId),
    );
  }

  resolveSystemAccount(
    kind: LedgerAccountKind.HouseWagering | LedgerAccountKind.ExternalFunding,
    currency: string,
  ): Promise<LedgerAccount> {
    const existing = this.accounts.find(
      (account) =>
        account.kind === kind &&
        account.currency === currency &&
        !account.walletId,
    );
    if (existing) {
      return Promise.resolve(existing);
    }

    this.systemCounter += 1;
    const account = LedgerAccount.openSystemAccount({
      id: `system-${this.systemCounter}`,
      kind,
      currency,
      at: new Date('2026-01-01T00:00:00.000Z'),
    });
    this.accounts.push(account);
    return Promise.resolve(account);
  }
}

export class FakeLedgerRepository implements LedgerRepositoryPort {
  readonly entries: WalletLedgerEntry[] = [];

  insertMany(entries: WalletLedgerEntry[]): Promise<void> {
    this.entries.push(...entries);
    return Promise.resolve();
  }

  listByAccount(
    accountId: string,
    limit: number,
    cursor: LedgerCursor | undefined,
  ): Promise<LedgerPage> {
    const ordered = this.entries
      .filter((entry) => entry.accountId === accountId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const start = cursor
      ? ordered.findIndex((entry) => entry.id === cursor.id) + 1
      : 0;
    const page = ordered.slice(start, start + limit);
    const last = page[page.length - 1];

    return Promise.resolve({
      entries: page,
      nextCursor:
        start + limit < ordered.length && last
          ? { createdAt: last.createdAt, id: last.id }
          : undefined,
    });
  }

  aggregateByAccount(
    accountId: string,
    currency: string,
  ): Promise<LedgerAggregate> {
    const scoped = this.entries.filter(
      (entry) => entry.accountId === accountId,
    );
    const signedSum = scoped.reduce(
      (total, entry) => total.add(entry.signedAmount()),
      Money.zero(currency),
    );

    return Promise.resolve({ signedSum, count: scoped.length });
  }
}

export class FakeWagerTransactionRepository implements WagerTransactionRepositoryPort {
  readonly transactions: WagerTransaction[] = [];

  insert(transaction: WagerTransaction): Promise<void> {
    this.transactions.push(transaction);
    return Promise.resolve();
  }

  /** Espelha o `ON CONFLICT DO NOTHING`: por idempotencyKey e por providerId + externalTransactionId. */
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean> {
    const clash = this.transactions.some(
      (existing) =>
        existing.idempotencyKey === transaction.idempotencyKey ||
        (existing.providerId === transaction.providerId &&
          existing.externalTransactionId === transaction.externalTransactionId),
    );
    if (clash) {
      return Promise.resolve(false);
    }

    this.transactions.push(transaction);
    return Promise.resolve(true);
  }

  /** O dublê guarda a própria instância, então a mutação já está visível. */
  update(): Promise<void> {
    return Promise.resolve();
  }

  findById(id: string): Promise<WagerTransaction | undefined> {
    return Promise.resolve(
      this.transactions.find((transaction) => transaction.id === id),
    );
  }

  async lockById(id: string): Promise<WagerTransaction | undefined> {
    return this.findById(id);
  }

  findDuePendingReferenceIds(limit: number, now: Date): Promise<string[]> {
    return Promise.resolve(
      this.transactions
        .filter(
          (transaction) =>
            transaction.status === WagerTransactionStatus.PendingReference &&
            (!transaction.nextAttemptAt ||
              transaction.nextAttemptAt.getTime() <= now.getTime()),
        )
        .slice(0, limit)
        .map((transaction) => transaction.id),
    );
  }

  findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    return Promise.resolve(
      this.transactions.find(
        (transaction) => transaction.idempotencyKey === idempotencyKey,
      ),
    );
  }

  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return Promise.resolve(
      this.transactions.find(
        (transaction) =>
          transaction.providerId === providerId &&
          transaction.externalTransactionId === externalTransactionId,
      ),
    );
  }

  hasProcessedReversalFor(referenceTransactionId: string): Promise<boolean> {
    return Promise.resolve(
      this.transactions.some(
        (transaction) =>
          transaction.referenceTransactionId === referenceTransactionId &&
          transaction.requiresReference() &&
          transaction.status === WagerTransactionStatus.Processed,
      ),
    );
  }
}

export class FakeOutboxRepository implements OutboxRepositoryPort {
  readonly messages: OutboxMessage[] = [];
  /** Ids já reivindicados: espelha o efeito do `FOR UPDATE SKIP LOCKED`. */
  readonly claimed = new Set<string>();

  insertMany(messages: OutboxMessage[]): Promise<void> {
    this.messages.push(...messages);
    return Promise.resolve();
  }

  claimDue(limit: number, now: Date): Promise<OutboxMessage[]> {
    const due = this.messages
      .filter((message) => message.isDue(now) && !this.claimed.has(message.id))
      .slice(0, limit);

    for (const message of due) {
      this.claimed.add(message.id);
    }
    return Promise.resolve(due);
  }

  markPublished(): Promise<void> {
    return Promise.resolve();
  }

  scheduleRetry(message: OutboxMessage): Promise<void> {
    this.claimed.delete(message.id);
    return Promise.resolve();
  }

  oldestPendingAgeSeconds(now: Date): Promise<number> {
    const pending = this.messages.filter((message) => message.isPending());
    if (pending.length === 0) {
      return Promise.resolve(0);
    }
    const oldest = Math.min(
      ...pending.map((message) => message.occurredAt.getTime()),
    );
    return Promise.resolve(Math.max(0, (now.getTime() - oldest) / 1000));
  }
}

export class FakeInboxRepository implements InboxRepositoryPort {
  readonly messages: InboxMessage[] = [];

  receiveIfAbsent(message: InboxMessage): Promise<boolean> {
    const exists = this.messages.some(
      (existing) =>
        existing.consumerName === message.consumerName &&
        existing.messageId === message.messageId,
    );
    if (exists) {
      return Promise.resolve(false);
    }

    this.messages.push(message);
    return Promise.resolve(true);
  }

  findOne(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined> {
    return Promise.resolve(
      this.messages.find(
        (message) =>
          message.consumerName === consumerName &&
          message.messageId === messageId,
      ),
    );
  }
}

export class FakeEventPublisher implements EventPublisherPort {
  readonly published: OutboxMessage[] = [];
  failTimes = 0;

  publish(message: OutboxMessage): Promise<void> {
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      return Promise.reject(new Error('broker unavailable'));
    }
    this.published.push(message);
    return Promise.resolve();
  }
}

export class FakeMetrics implements MetricsPort {
  walletsOpened = 0;
  idempotentReplays = 0;
  idempotencyConflicts = 0;
  inboxDuplicates = 0;
  outboxLagSeconds = 0;
  readonly reconciliations: boolean[] = [];
  readonly transactions: { status: string; kind: string }[] = [];
  readonly retries: string[] = [];
  readonly dlqMessages: string[] = [];
  readonly latencies: { source: string; seconds: number }[] = [];

  recordWalletOpened(): void {
    this.walletsOpened += 1;
  }

  recordReconciliation(consistent: boolean): void {
    this.reconciliations.push(consistent);
  }

  recordTransaction(status: string, kind: string): void {
    this.transactions.push({ status, kind });
  }

  recordIdempotentReplay(): void {
    this.idempotentReplays += 1;
  }

  recordIdempotencyConflict(): void {
    this.idempotencyConflicts += 1;
  }

  recordInboxDuplicate(): void {
    this.inboxDuplicates += 1;
  }

  recordRetry(stage: string): void {
    this.retries.push(stage);
  }

  recordDlqMessage(reason: string): void {
    this.dlqMessages.push(reason);
  }

  recordOutboxLag(seconds: number): void {
    this.outboxLagSeconds = seconds;
  }

  observeProcessingLatency(source: string, seconds: number): void {
    this.latencies.push({ source, seconds });
  }
}
