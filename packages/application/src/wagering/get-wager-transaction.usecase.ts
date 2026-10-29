import type { WagerTransaction } from '@wagering/domain';
import { WagerTransactionNotFoundError } from '../errors.js';
import type { WagerTransactionRepositoryPort } from '../ports/index.js';

export class GetWagerTransactionUseCase {
  constructor(private readonly transactions: WagerTransactionRepositoryPort) {}

  async execute(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.transactions.findById(transactionId);
    if (!transaction) {
      throw new WagerTransactionNotFoundError(transactionId);
    }
    return transaction;
  }
}

export class GetWagerTransactionByExternalIdUseCase {
  constructor(private readonly transactions: WagerTransactionRepositoryPort) {}

  async execute(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction> {
    const transaction = await this.transactions.findByProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
    if (!transaction) {
      throw new WagerTransactionNotFoundError(
        `${providerId}:${externalTransactionId}`,
      );
    }
    return transaction;
  }
}
