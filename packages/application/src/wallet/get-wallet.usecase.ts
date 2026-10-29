import type { Wallet } from '@wagering/domain';
import { WalletNotFoundError } from '../errors.js';
import type { WalletRepositoryPort } from '../ports/index.js';

export class GetWalletUseCase {
  constructor(private readonly wallets: WalletRepositoryPort) {}

  async execute(walletId: string): Promise<Wallet> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return wallet;
  }
}
