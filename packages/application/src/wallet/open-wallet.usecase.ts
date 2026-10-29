import {
  LedgerAccount,
  LedgerAccountKind,
  LedgerDirection,
  Money,
  type MoneyProps,
  OutboxMessage,
  WagerTransaction,
  Wallet,
  WalletBalanceChanged,
  WalletLedgerEntry,
} from '@wagering/domain';
import type {
  ClockPort,
  IdGeneratorPort,
  LedgerAccountRepositoryPort,
  LedgerRepositoryPort,
  MetricsPort,
  OutboxRepositoryPort,
  PayloadHasherPort,
  TransactionRunnerPort,
  WagerTransactionRepositoryPort,
  WalletRepositoryPort,
} from '../ports/index.js';

export interface OpenWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface OpenWalletDeps {
  wallets: WalletRepositoryPort;
  accounts: LedgerAccountRepositoryPort;
  ledger: LedgerRepositoryPort;
  transactions: WagerTransactionRepositoryPort;
  outbox: OutboxRepositoryPort;
  runner: TransactionRunnerPort;
  clock: ClockPort;
  ids: IdGeneratorPort;
  hasher: PayloadHasherPort;
  metrics: MetricsPort;
}

/**
 * Cria a wallet e, quando há saldo inicial, a transação interna `OPENING` com o
 * lançamento correspondente, tudo na mesma transação.
 *
 * A duplicidade por `playerId` + `currency` é barrada pela unique constraint.
 * Um `SELECT` antes não resolveria várias instâncias criando a mesma wallet ao
 * mesmo tempo.
 */
export class OpenWalletUseCase {
  constructor(private readonly deps: OpenWalletDeps) {}

  async execute(input: OpenWalletInput): Promise<Wallet> {
    const initialBalance = Money.from(input.initialBalance);

    const wallet = await this.deps.runner.run(async () => {
      const now = this.deps.clock.now();
      const walletId = this.deps.ids.next();

      const { wallet, openingChange } = Wallet.open({
        id: walletId,
        playerId: input.playerId,
        initialBalance,
        at: now,
      });

      await this.deps.wallets.insert(wallet);

      const account = LedgerAccount.openForWallet({
        id: this.deps.ids.next(),
        walletId,
        currency: wallet.currency,
        at: now,
      });
      await this.deps.accounts.insert(account);

      if (openingChange) {
        const funding = await this.deps.accounts.resolveSystemAccount(
          LedgerAccountKind.ExternalFunding,
          wallet.currency,
        );

        const transactionId = this.deps.ids.next();
        const transaction = WagerTransaction.opening({
          id: transactionId,
          walletId,
          playerId: wallet.playerId,
          money: initialBalance,
          payloadHash: this.deps.hasher.hash({
            kind: 'OPENING',
            walletId,
            playerId: wallet.playerId,
            amount: initialBalance.toString(),
            currency: wallet.currency,
          }),
          at: now,
        });
        await this.deps.transactions.insert(transaction);

        const walletEntry = WalletLedgerEntry.create({
          id: this.deps.ids.next(),
          accountId: account.id,
          transactionId,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: openingChange.balanceBefore,
          balanceAfter: openingChange.balanceAfter,
          createdAt: now,
        });

        // Contrapartida de partidas dobradas: sem saldo materializado, para
        // não criar uma linha quente travada por todas as wallets.
        const fundingEntry = WalletLedgerEntry.create({
          id: this.deps.ids.next(),
          accountId: funding.id,
          transactionId,
          direction: LedgerDirection.Debit,
          money: initialBalance,
          balanceBefore: undefined,
          balanceAfter: undefined,
          createdAt: now,
        });

        await this.deps.ledger.insertMany([walletEntry, fundingEntry]);

        const event = WalletBalanceChanged.from(wallet, walletEntry, {
          eventId: this.deps.ids.next(),
          correlationId: input.correlationId,
          causationId: transactionId,
          occurredAt: now,
        });
        await this.deps.outbox.insertMany([OutboxMessage.enqueue(event)]);
      }

      return wallet;
    });

    this.deps.metrics.recordWalletOpened();

    return wallet;
  }
}
