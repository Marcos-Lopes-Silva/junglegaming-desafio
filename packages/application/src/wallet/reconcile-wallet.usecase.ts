import type { Money } from '@wagering/domain';
import { WalletNotFoundError } from '../errors.js';
import type {
  LedgerAccountRepositoryPort,
  LedgerRepositoryPort,
  MetricsPort,
  WalletRepositoryPort,
} from '../ports/index.js';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compara o saldo materializado com o saldo reconstruído pelo ledger.
 *
 * Divergências não são corrigidas: são contadas em métrica e devolvidas no
 * resultado.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly wallets: WalletRepositoryPort,
    private readonly accounts: LedgerAccountRepositoryPort,
    private readonly ledger: LedgerRepositoryPort,
    private readonly metrics: MetricsPort,
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    const account = await this.accounts.findForWallet(wallet.id);
    if (!account) {
      throw new WalletNotFoundError(walletId);
    }

    const { signedSum, count } = await this.ledger.aggregateByAccount(
      account.id,
      wallet.currency,
    );

    const storedBalance = wallet.balance;
    const difference = storedBalance.subtract(signedSum);
    const consistent = difference.isZero();

    this.metrics.recordReconciliation(consistent);

    return {
      walletId: wallet.id,
      storedBalance,
      calculatedBalance: signedSum,
      difference,
      consistent,
      checkedEntries: count,
    };
  }
}
