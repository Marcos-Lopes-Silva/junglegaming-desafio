import { WagerTransactionStatus } from '@wagering/domain';
import type {
  ClockPort,
  IdGeneratorPort,
  MetricsPort,
  TransactionRunnerPort,
  WagerTransactionRepositoryPort,
  WalletRepositoryPort,
} from '../ports/index.js';
import type { WagerTransactionApplier } from '../wagering/wager-transaction.applier.js';

export interface ProcessPendingReferencesResult {
  examined: number;
  settled: number;
}

export interface ProcessPendingReferencesDeps {
  transactions: WagerTransactionRepositoryPort;
  wallets: WalletRepositoryPort;
  applier: WagerTransactionApplier;
  runner: TransactionRunnerPort;
  clock: ClockPort;
  ids: IdGeneratorPort;
  metrics: MetricsPort;
}

export const PENDING_REFERENCE_BATCH_SIZE = 20;

/**
 * Cada transação é tratada na sua própria transação SQL, nesta ordem:
 *
 *   1. leitura sem lock, só para descobrir a `walletId`
 *   2. `FOR UPDATE` na wallet
 *   3. `FOR UPDATE` na transação, com reconferência do status
 *
 * A submissão trava a wallet antes da transação, e inverter a ordem aqui
 * poderia causar deadlock. Como o status é conferido de novo depois do lock,
 * várias instâncias podem rodar juntas: quem chega depois encontra a transação
 * já resolvida.
 */
export class ProcessPendingReferencesUseCase {
  constructor(private readonly deps: ProcessPendingReferencesDeps) {}

  async execute(
    limit: number = PENDING_REFERENCE_BATCH_SIZE,
  ): Promise<ProcessPendingReferencesResult> {
    const now = this.deps.clock.now();
    const ids = await this.deps.transactions.findDuePendingReferenceIds(
      limit,
      now,
    );

    let settled = 0;
    for (const id of ids) {
      if (await this.settleOne(id)) {
        settled += 1;
      }
    }

    return { examined: ids.length, settled };
  }

  private async settleOne(id: string): Promise<boolean> {
    const startedAt = this.deps.clock.now();

    const didSettle = await this.deps.runner.run(async () => {
      const now = this.deps.clock.now();

      const peek = await this.deps.transactions.findById(id);
      if (!peek || peek.status !== WagerTransactionStatus.PendingReference) {
        return false;
      }

      const wallet = await this.deps.wallets.lockById(peek.walletId);
      if (!wallet) {
        return false;
      }

      const transaction = await this.deps.transactions.lockById(id);
      if (
        !transaction ||
        transaction.status !== WagerTransactionStatus.PendingReference ||
        (transaction.nextAttemptAt &&
          transaction.nextAttemptAt.getTime() > now.getTime())
      ) {
        // Outra instância chegou primeiro, ou a janela de retentativa ainda
        // não abriu.
        return false;
      }

      this.deps.metrics.recordRetry('pending-reference');

      await this.deps.applier.settle({
        transaction,
        wallet,
        now,
        // O correlationId da requisição original não está disponível aqui;
        // usa um novo, com a transação como causa.
        correlationId: this.deps.ids.next(),
        causationId: transaction.id,
        attempt: 'retry',
      });

      return transaction.status !== WagerTransactionStatus.PendingReference;
    });

    const elapsedMs = this.deps.clock.now().getTime() - startedAt.getTime();
    this.deps.metrics.observeProcessingLatency(
      'pending-reference',
      elapsedMs / 1000,
    );

    return didSettle;
  }
}
