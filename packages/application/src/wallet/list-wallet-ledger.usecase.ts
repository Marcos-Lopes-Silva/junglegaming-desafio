import { WalletNotFoundError } from '../errors.js';
import type {
  LedgerAccountRepositoryPort,
  LedgerCursor,
  LedgerPage,
  LedgerRepositoryPort,
  WalletRepositoryPort,
} from '../ports/index.js';

export const LEDGER_PAGE_DEFAULT_LIMIT = 50;
export const LEDGER_PAGE_MAX_LIMIT = 200;

export interface ListWalletLedgerInput {
  walletId: string;
  limit?: number | undefined;
  cursor?: LedgerCursor | undefined;
}

/**
 * Paginação keyset por `(createdAt, id)` em ordem decrescente.
 *
 * Keyset em vez de OFFSET porque o ledger só cresce: o cursor continua
 * apontando para o mesmo lugar mesmo com lançamentos novos chegando.
 */
export class ListWalletLedgerUseCase {
  constructor(
    private readonly wallets: WalletRepositoryPort,
    private readonly accounts: LedgerAccountRepositoryPort,
    private readonly ledger: LedgerRepositoryPort,
  ) {}

  async execute(input: ListWalletLedgerInput): Promise<LedgerPage> {
    const wallet = await this.wallets.findById(input.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(input.walletId);
    }

    const account = await this.accounts.findForWallet(wallet.id);
    if (!account) {
      throw new WalletNotFoundError(input.walletId);
    }

    const limit = Math.min(
      input.limit ?? LEDGER_PAGE_DEFAULT_LIMIT,
      LEDGER_PAGE_MAX_LIMIT,
    );

    return this.ledger.listByAccount(account.id, limit, input.cursor);
  }
}
