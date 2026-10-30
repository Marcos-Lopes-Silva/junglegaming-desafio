import {
  EntityManager,
  LockMode,
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';
import {
  WalletAlreadyExistsError,
  type WalletRepositoryPort,
} from '@wagering/application';
import type { Wallet } from '@wagering/domain';
import { fromWallet, toWallet } from '../database/mappers.js';
import { WalletSchema } from '../database/schemas.js';

export class WalletRepository implements WalletRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async findById(walletId: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletSchema, { id: walletId });
    return row ? toWallet(row) : undefined;
  }

  /**
   * `SELECT ... FOR UPDATE` por linha: a unidade de concorrência é a `walletId`
   * e wallets diferentes nunca se bloqueiam.
   */
  async lockById(walletId: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(
      WalletSchema,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return row ? toWallet(row) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletSchema, fromWallet(wallet));
    } catch (error) {
      // A unique constraint garante uma wallet por player+moeda; um SELECT
      // antes não resolveria duas criações simultâneas.
      if (error instanceof UniqueConstraintViolationException) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  async update(wallet: Wallet): Promise<void> {
    const row = fromWallet(wallet);
    await this.em.nativeUpdate(
      WalletSchema,
      { id: row.id },
      {
        balanceAmount: row.balanceAmount,
        version: row.version,
        updatedAt: row.updatedAt,
      },
    );
  }
}
