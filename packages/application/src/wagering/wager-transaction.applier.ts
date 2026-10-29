import {
  type BalanceChange,
  FailureCode,
  InsufficientFundsError,
  LedgerAccountKind,
  LedgerDirection,
  type Money,
  OutboxMessage,
  type WagerTransaction,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionStatus,
  type Wallet,
  WalletBalanceChanged,
  WalletLedgerEntry,
  checkReference,
  isPendingReferenceExhausted,
  nextPendingReferenceAttemptAt,
} from '@wagering/domain';
import { WalletNotFoundError } from '../errors.js';
import type {
  IdGeneratorPort,
  LedgerAccountRepositoryPort,
  LedgerRepositoryPort,
  MetricsPort,
  OutboxRepositoryPort,
  WagerTransactionRepositoryPort,
  WalletRepositoryPort,
} from '../ports/index.js';

/**
 * Na primeira submissão, referência ausente estaciona a transação e publica o
 * evento; numa retentativa, o TTL decide entre estacionar de novo ou rejeitar
 * em definitivo.
 */
export type SettleAttempt = 'initial' | 'retry';

export interface SettleContext {
  transaction: WagerTransaction;
  wallet: Wallet;
  now: Date;
  correlationId: string;
  causationId?: string | undefined;
  attempt: SettleAttempt;
}

export interface SettleResult {
  transaction: WagerTransaction;
  balance: Money;
}

export interface WagerTransactionApplierDeps {
  wallets: WalletRepositoryPort;
  accounts: LedgerAccountRepositoryPort;
  ledger: LedgerRepositoryPort;
  transactions: WagerTransactionRepositoryPort;
  outbox: OutboxRepositoryPort;
  ids: IdGeneratorPort;
  metrics: MetricsPort;
}

/**
 * Regras usadas pela submissão e pelo reprocessamento de `PENDING_REFERENCE`.
 * Espera a transação aberta e a wallet já travada; a wallet é sempre travada
 * primeiro, para evitar deadlock entre os dois.
 */
export class WagerTransactionApplier {
  constructor(private readonly deps: WagerTransactionApplierDeps) {}

  async settle(ctx: SettleContext): Promise<SettleResult> {
    const { transaction, wallet } = ctx;

    if (wallet.playerId !== transaction.playerId) {
      return this.reject(ctx, FailureCode.WalletPlayerMismatch);
    }
    if (wallet.currency !== transaction.money.currency) {
      return this.reject(ctx, FailureCode.CurrencyMismatch);
    }

    const reference = await this.resolveReference(ctx);
    if (reference.outcome === 'settled') {
      return reference.result;
    }

    return this.applyBalance(ctx, reference.reference);
  }

  private async resolveReference(
    ctx: SettleContext,
  ): Promise<
    | { outcome: 'ok'; reference: WagerTransaction | undefined }
    | { outcome: 'settled'; result: SettleResult }
  > {
    const { transaction } = ctx;
    const externalId = transaction.referenceExternalTransactionId;

    if (!externalId) {
      return { outcome: 'ok', reference: undefined };
    }

    const reference = await this.deps.transactions.findByProviderAndExternalId(
      transaction.providerId,
      externalId,
    );

    if (!reference) {
      return { outcome: 'settled', result: await this.park(ctx) };
    }

    const alreadyReversed = transaction.requiresReference()
      ? await this.deps.transactions.hasProcessedReversalFor(reference.id)
      : false;

    const failure = checkReference({ transaction, reference, alreadyReversed });
    if (failure) {
      return { outcome: 'settled', result: await this.reject(ctx, failure) };
    }

    transaction.attachReference(reference.id);
    return { outcome: 'ok', reference };
  }

  private async applyBalance(
    ctx: SettleContext,
    reference: WagerTransaction | undefined,
  ): Promise<SettleResult> {
    const { transaction, wallet, now } = ctx;

    if (!transaction.affectsBalance()) {
      transaction.markProcessed(reference?.id, now, wallet.balance);
      await this.deps.transactions.update(transaction);
      await this.publishProcessed(ctx, false);

      this.deps.metrics.recordTransaction(
        WagerTransactionStatus.Processed,
        transaction.kind,
      );
      return { transaction, balance: wallet.balance };
    }

    const direction = transaction.ledgerDirectionFor(reference);
    let change: BalanceChange;
    try {
      change =
        direction === LedgerDirection.Debit
          ? wallet.debit(transaction.money, now)
          : wallet.credit(transaction.money, now);
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        // Aposta sem saldo e reversão sem saldo são situações
        // operacionalmente diferentes e precisam de códigos distintos.
        return this.reject(
          ctx,
          transaction.requiresReference()
            ? FailureCode.InsufficientFundsForReversal
            : FailureCode.InsufficientFunds,
        );
      }
      throw error;
    }

    const account = await this.deps.accounts.findForWallet(wallet.id);
    if (!account) {
      throw new WalletNotFoundError(wallet.id);
    }
    const house = await this.deps.accounts.resolveSystemAccount(
      LedgerAccountKind.HouseWagering,
      wallet.currency,
    );

    const walletEntry = WalletLedgerEntry.create({
      id: this.deps.ids.next(),
      accountId: account.id,
      transactionId: transaction.id,
      direction: change.direction,
      money: transaction.money,
      balanceBefore: change.balanceBefore,
      balanceAfter: change.balanceAfter,
      createdAt: now,
    });

    // Contrapartida de partidas dobradas, sem saldo materializado.
    const houseEntry = WalletLedgerEntry.create({
      id: this.deps.ids.next(),
      accountId: house.id,
      transactionId: transaction.id,
      direction:
        change.direction === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit,
      money: transaction.money,
      balanceBefore: undefined,
      balanceAfter: undefined,
      createdAt: now,
    });

    await this.deps.ledger.insertMany([walletEntry, houseEntry]);
    await this.deps.wallets.update(wallet);

    transaction.markProcessed(reference?.id, now, change.balanceAfter);
    await this.deps.transactions.update(transaction);

    await this.publishProcessed(ctx, true, walletEntry);

    this.deps.metrics.recordTransaction(
      WagerTransactionStatus.Processed,
      transaction.kind,
    );
    return { transaction, balance: change.balanceAfter };
  }

  /**
   * Numa retentativa, consulta o TTL antes de estacionar de novo. O evento de
   * pendência não é publicado outra vez.
   */
  private async park(ctx: SettleContext): Promise<SettleResult> {
    const { transaction, wallet, now, attempt } = ctx;

    if (
      attempt === 'retry' &&
      isPendingReferenceExhausted(
        transaction.attempts,
        transaction.createdAt,
        now,
      )
    ) {
      return this.reject(ctx, FailureCode.ReferenceNotFound);
    }

    transaction.markPendingReference(
      nextPendingReferenceAttemptAt(transaction.attempts + 1, now),
      wallet.balance,
    );
    await this.deps.transactions.update(transaction);

    if (attempt === 'initial') {
      await this.deps.outbox.insertMany([
        OutboxMessage.enqueue(
          WagerTransactionPendingReference.from(
            transaction,
            this.eventContext(ctx, now),
          ),
        ),
      ]);
    }

    this.deps.metrics.recordTransaction(
      WagerTransactionStatus.PendingReference,
      transaction.kind,
    );

    return { transaction, balance: wallet.balance };
  }

  private async reject(
    ctx: SettleContext,
    code: FailureCode,
  ): Promise<SettleResult> {
    const { transaction, wallet, now } = ctx;

    transaction.reject(code, now, wallet.balance);
    await this.deps.transactions.update(transaction);

    await this.deps.outbox.insertMany([
      OutboxMessage.enqueue(
        WagerTransactionRejected.from(
          transaction,
          wallet.balance.toJSON(),
          this.eventContext(ctx, now),
        ),
      ),
    ]);

    this.deps.metrics.recordTransaction(
      WagerTransactionStatus.Rejected,
      transaction.kind,
    );
    return { transaction, balance: wallet.balance };
  }

  private async publishProcessed(
    ctx: SettleContext,
    affectedBalance: boolean,
    entry?: WalletLedgerEntry,
  ): Promise<void> {
    const { transaction, wallet, now } = ctx;

    const events = [
      OutboxMessage.enqueue(
        WagerTransactionProcessed.from(
          transaction,
          wallet.balance.toJSON(),
          affectedBalance,
          this.eventContext(ctx, now),
        ),
      ),
    ];

    // WalletBalanceChanged sai somente quando o saldo muda.
    if (affectedBalance && entry) {
      events.push(
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, entry, this.eventContext(ctx, now)),
        ),
      );
    }

    await this.deps.outbox.insertMany(events);
  }

  private eventContext(ctx: SettleContext, occurredAt: Date) {
    return {
      eventId: this.deps.ids.next(),
      correlationId: ctx.correlationId,
      causationId: ctx.causationId ?? ctx.transaction.id,
      occurredAt,
    };
  }
}
