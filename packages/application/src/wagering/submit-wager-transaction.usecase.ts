import {
  Money,
  type MoneyProps,
  WagerTransaction,
  type WagerTransactionKind,
  type Wallet,
} from '@wagering/domain';
import { IdempotencyConflictError, WalletNotFoundError } from '../errors.js';
import type {
  ClockPort,
  IdGeneratorPort,
  MetricsPort,
  PayloadHasherPort,
  TransactionRunnerPort,
  WagerTransactionRepositoryPort,
  WalletRepositoryPort,
} from '../ports/index.js';
import type { WagerTransactionApplier } from './wager-transaction.applier.js';

export interface SubmitWagerTransactionInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  correlationId: string;
  causationId?: string | undefined;
}

export interface SubmitWagerTransactionResult {
  transaction: WagerTransaction;
  /** Saldo observado no desfecho; no replay, o saldo original. */
  balance: Money;
  idempotentReplay: boolean;
}

export interface SubmitWagerTransactionDeps {
  wallets: WalletRepositoryPort;
  transactions: WagerTransactionRepositoryPort;
  applier: WagerTransactionApplier;
  runner: TransactionRunnerPort;
  clock: ClockPort;
  ids: IdGeneratorPort;
  hasher: PayloadHasherPort;
  metrics: MetricsPort;
}

/** Campos de negócio do hash canônico: chave de idempotência e correlação ficam de fora. */
export function wagerBusinessPayload(
  input: SubmitWagerTransactionInput,
): Record<string, unknown> {
  return {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    amount: input.money.amount,
    currency: input.money.currency,
    referenceExternalTransactionId: input.referenceExternalTransactionId,
  };
}

/**
 * Ponto único de submissão, qualquer que seja a origem. Tudo roda numa única
 * transação, nesta ordem fixa para evitar deadlock:
 *
 *   1. lock pessimista na wallet (`FOR UPDATE`)
 *   2. `INSERT ... ON CONFLICT DO NOTHING` da transação, que decide a
 *      idempotência
 *   3. referência, saldo, ledger e eventos, via `WagerTransactionApplier`
 *
 * Rejeições não lançam exceção, porque o rollback apagaria o registro da
 * rejeição.
 */
export class SubmitWagerTransactionUseCase {
  constructor(private readonly deps: SubmitWagerTransactionDeps) {}

  async execute(
    input: SubmitWagerTransactionInput,
  ): Promise<SubmitWagerTransactionResult> {
    // Valida antes de abrir a transação.
    const money = Money.from(input.money);
    const payloadHash = this.deps.hasher.hash(wagerBusinessPayload(input));

    return this.deps.runner.run(async () => {
      const now = this.deps.clock.now();

      // 1. Lock da wallet.
      const wallet = await this.deps.wallets.lockById(input.walletId);
      if (!wallet) {
        // A transação referencia a wallet, então não há como persistir a
        // tentativa de forma auditável: lança sem registro.
        throw new WalletNotFoundError(input.walletId);
      }

      // 2. A idempotência é decidida pela unique constraint. Um SELECT antes
      //    não funcionaria com duas instâncias concorrentes.
      const transaction = WagerTransaction.create({
        id: this.deps.ids.next(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        money,
        referenceExternalTransactionId: input.referenceExternalTransactionId,
        createdAt: now,
      });

      const inserted = await this.deps.transactions.insertIfAbsent(transaction);
      if (!inserted) {
        return this.replayOrConflict(input, payloadHash, wallet);
      }

      // 3. Regras compartilhadas com o reprocessamento de PENDING_REFERENCE.
      const settled = await this.deps.applier.settle({
        transaction,
        wallet,
        now,
        correlationId: input.correlationId,
        causationId: input.causationId,
        attempt: 'initial',
      });

      return { ...settled, idempotentReplay: false };
    });
  }

  private async replayOrConflict(
    input: SubmitWagerTransactionInput,
    payloadHash: string,
    wallet: Wallet,
  ): Promise<SubmitWagerTransactionResult> {
    const byKey = await this.deps.transactions.findByIdempotencyKey(
      input.idempotencyKey,
    );

    // Sem linha para esta key, mas o INSERT conflitou: o par (providerId,
    // externalTransactionId) já existe com outra key. É tratado como conflito.
    if (!byKey || !byKey.matchesPayload(payloadHash)) {
      this.deps.metrics.recordIdempotencyConflict();
      throw new IdempotencyConflictError(input.idempotencyKey);
    }

    this.deps.metrics.recordIdempotentReplay();

    return {
      transaction: byKey,
      balance: byKey.observedBalance ?? wallet.balance,
      idempotentReplay: true,
    };
  }
}
