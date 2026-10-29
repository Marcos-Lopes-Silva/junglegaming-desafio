import { beforeEach, describe, expect, it } from 'bun:test';
import {
  IdempotencyConflictError,
  WalletNotFoundError,
} from '@wagering/application';
import {
  FailureCode,
  InternalKindNotAllowedError,
  LedgerDirection,
  MissingReferenceError,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@wagering/domain';
import {
  OTHER_PLAYER,
  PROVIDER,
  type WageringHarness,
  buildWageringHarness,
  eventTypes,
  ledgerImbalance,
  openWallet,
  resultOf,
  submitInput,
} from './wagering.harness.js';

let h: WageringHarness;

beforeEach(() => {
  h = buildWageringHarness();
});

describe('BET', () => {
  it('debita o saldo e produz um par de lançamentos', async () => {
    const wallet = await openWallet(h, '100.00');

    const result = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
      }),
    );

    expect(resultOf(result)).toEqual({
      status: WagerTransactionStatus.Processed,
      failureCode: undefined,
      balance: '75.00',
      replay: false,
    });
    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(2);

    const entries = h.ledger.entries.filter(
      (e) => e.transactionId === result.transaction.id,
    );
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.balanceAfter)?.direction).toBe(
      LedgerDirection.Debit,
    );
    expect(ledgerImbalance(h)).toBe('0.00');
  });

  it('publica WagerTransactionProcessed e WalletBalanceChanged', async () => {
    const wallet = await openWallet(h, '100.00');
    h.outbox.messages.length = 0;

    await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
      }),
    );

    expect(eventTypes(h)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('rejeita por saldo insuficiente sem mover saldo nem ledger', async () => {
    const wallet = await openWallet(h, '10.00');

    const result = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
      }),
    );

    expect(resultOf(result)).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      balance: '10.00',
      replay: false,
    });
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1);
    expect(
      h.ledger.entries.filter((e) => e.transactionId === result.transaction.id),
    ).toHaveLength(0);
  });

  it('a rejeição fica persistida e auditável', async () => {
    const wallet = await openWallet(h, '10.00');

    const result = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
      }),
    );

    // A rejeição fica gravada.
    const persisted = await h.transactions.findById(result.transaction.id);
    expect(persisted?.status).toBe(WagerTransactionStatus.Rejected);
    expect(eventTypes(h)).toContain('WagerTransactionRejected');
  });

  it('permite zerar o saldo exatamente', async () => {
    const wallet = await openWallet(h, '25.00');

    const result = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
      }),
    );

    expect(result.balance.toString()).toBe('0.00');
  });
});

describe('WIN', () => {
  it('credita o saldo', async () => {
    const wallet = await openWallet(h, '100.00');

    const result = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Win,
        amount: '40.00',
      }),
    );

    expect(result.balance.toString()).toBe('140.00');
    expect(ledgerImbalance(h)).toBe('0.00');
  });
});

describe('LOSS', () => {
  it('registra o resultado sem mover saldo nem gerar lançamento', async () => {
    const wallet = await openWallet(h, '100.00');
    h.outbox.messages.length = 0;
    const entriesBefore = h.ledger.entries.length;

    const result = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Loss,
        amount: '25.00',
      }),
    );

    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(h.ledger.entries).toHaveLength(entriesBefore);
  });

  it('publica Processed mas não WalletBalanceChanged', async () => {
    const wallet = await openWallet(h, '100.00');
    h.outbox.messages.length = 0;

    await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Loss,
        amount: '25.00',
      }),
    );

    // WalletBalanceChanged sai somente quando o saldo muda.
    expect(eventTypes(h)).toEqual(['WagerTransactionProcessed']);
    const payload = h.outbox.messages[0]?.payload as {
      data: { affectedBalance: boolean };
    };
    expect(payload.data.affectedBalance).toBe(false);
  });
});

describe('REFUND', () => {
  const placeBet = async (
    walletId: string,
    amount = '25.00',
    external = 'bet-1',
  ) =>
    h.submit.execute(
      submitInput({
        walletId,
        kind: WagerTransactionKind.Bet,
        amount,
        externalTransactionId: external,
      }),
    );

  it('reverte uma BET processada creditando o mesmo valor', async () => {
    const wallet = await openWallet(h, '100.00');
    await placeBet(wallet.id);

    const result = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        referenceExternalTransactionId: 'bet-1',
      }),
    );

    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.toString()).toBe('100.00');
    expect(result.transaction.referenceTransactionId).toBeDefined();
    expect(ledgerImbalance(h)).toBe('0.00');
  });

  it('recusa a segunda reversão da mesma referência', async () => {
    const wallet = await openWallet(h, '100.00');
    await placeBet(wallet.id);

    await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        externalTransactionId: 'refund-1',
        referenceExternalTransactionId: 'bet-1',
      }),
    );

    const second = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        externalTransactionId: 'refund-2',
        referenceExternalTransactionId: 'bet-1',
      }),
    );

    expect(second.transaction.failureCode).toBe(
      FailureCode.ReferenceAlreadyReversed,
    );
    expect(second.balance.toString()).toBe('100.00');
  });

  it('recusa ROLLBACK depois de um REFUND na mesma BET', async () => {
    // Qualquer segunda reversão é recusada, não só a do mesmo tipo:
    // REFUND + ROLLBACK creditaria o jogador duas vezes.
    const wallet = await openWallet(h, '100.00');
    await placeBet(wallet.id);

    await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        externalTransactionId: 'refund-1',
        referenceExternalTransactionId: 'bet-1',
      }),
    );

    const rollback = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Rollback,
        amount: '25.00',
        externalTransactionId: 'rollback-1',
        referenceExternalTransactionId: 'bet-1',
      }),
    );

    expect(rollback.transaction.failureCode).toBe(
      FailureCode.ReferenceAlreadyReversed,
    );
    expect(wallet.balance.toString()).toBe('100.00');
  });

  it('recusa referenciar algo que não é BET', async () => {
    const wallet = await openWallet(h, '100.00');
    await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Win,
        amount: '25.00',
        externalTransactionId: 'win-1',
      }),
    );

    const result = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        referenceExternalTransactionId: 'win-1',
      }),
    );

    expect(result.transaction.failureCode).toBe(
      FailureCode.ReferenceKindNotReversible,
    );
  });

  it('recusa valor diferente do da referência', async () => {
    const wallet = await openWallet(h, '100.00');
    await placeBet(wallet.id, '25.00');

    const result = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Refund,
        amount: '10.00',
        referenceExternalTransactionId: 'bet-1',
      }),
    );

    expect(result.transaction.failureCode).toBe(
      FailureCode.ReferenceAmountMismatch,
    );
  });

  it('recusa referência de outra rodada', async () => {
    const wallet = await openWallet(h, '100.00');
    await placeBet(wallet.id);

    const result = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        roundId: 'outra-rodada',
        referenceExternalTransactionId: 'bet-1',
      }),
    );

    expect(result.transaction.failureCode).toBe(
      FailureCode.ReferenceScopeMismatch,
    );
  });

  it('recusa referência que não está PROCESSED', async () => {
    const wallet = await openWallet(h, '10.00');
    await placeBet(wallet.id, '25.00');

    const result = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        referenceExternalTransactionId: 'bet-1',
      }),
    );

    expect(result.transaction.failureCode).toBe(
      FailureCode.ReferenceNotProcessed,
    );
  });

  it('exige referência', async () => {
    const wallet = await openWallet(h, '100.00');

    const error = await h.submit
      .execute(
        submitInput({
          walletId: wallet.id,
          kind: WagerTransactionKind.Refund,
          amount: '25.00',
        }),
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MissingReferenceError);
  });
});

describe('ROLLBACK', () => {
  it('inverte a direção da referência: BET revertida credita', async () => {
    const wallet = await openWallet(h, '100.00');
    await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
        externalTransactionId: 'bet-1',
      }),
    );

    const result = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Rollback,
        amount: '25.00',
        referenceExternalTransactionId: 'bet-1',
      }),
    );

    expect(result.balance.toString()).toBe('100.00');
  });

  it('WIN revertida debita', async () => {
    const wallet = await openWallet(h, '100.00');
    await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Win,
        amount: '40.00',
        externalTransactionId: 'win-1',
      }),
    );

    const result = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Rollback,
        amount: '40.00',
        referenceExternalTransactionId: 'win-1',
      }),
    );

    expect(result.balance.toString()).toBe('100.00');
    expect(ledgerImbalance(h)).toBe('0.00');
  });

  it('reversão sem saldo tem failureCode distinto do de aposta sem saldo', async () => {
    // São situações operacionalmente diferentes.
    const wallet = await openWallet(h, '0.00');
    await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Win,
        amount: '40.00',
        externalTransactionId: 'win-1',
      }),
    );
    await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Bet,
        amount: '40.00',
        externalTransactionId: 'bet-1',
      }),
    );

    const result = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Rollback,
        amount: '40.00',
        referenceExternalTransactionId: 'win-1',
      }),
    );

    expect(result.transaction.failureCode).toBe(
      FailureCode.InsufficientFundsForReversal,
    );
    expect(result.transaction.failureCode).not.toBe(
      FailureCode.InsufficientFunds,
    );
    expect(wallet.balance.toString()).toBe('0.00');
  });
});

describe('referência fora de ordem', () => {
  it('sem a referência, fica PENDING_REFERENCE sem tocar no saldo', async () => {
    const wallet = await openWallet(h, '100.00');
    h.outbox.messages.length = 0;

    const result = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Rollback,
        amount: '25.00',
        referenceExternalTransactionId: 'ainda-nao-chegou',
      }),
    );

    expect(result.transaction.status).toBe(
      WagerTransactionStatus.PendingReference,
    );
    expect(result.transaction.attempts).toBe(1);
    expect(result.transaction.nextAttemptAt).toBeDefined();
    expect(result.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(eventTypes(h)).toEqual(['WagerTransactionPendingReference']);
  });

  it('WIN com referência ausente segue o mesmo caminho', async () => {
    const wallet = await openWallet(h, '100.00');

    const result = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Win,
        amount: '25.00',
        referenceExternalTransactionId: 'ainda-nao-chegou',
      }),
    );

    expect(result.transaction.status).toBe(
      WagerTransactionStatus.PendingReference,
    );
  });
});

describe('validações de escopo', () => {
  it('recusa player divergente da wallet', async () => {
    const wallet = await openWallet(h, '100.00');

    const result = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
        playerId: OTHER_PLAYER,
      }),
    );

    expect(result.transaction.failureCode).toBe(
      FailureCode.WalletPlayerMismatch,
    );
  });

  it('recusa moeda divergente da wallet', async () => {
    const wallet = await openWallet(h, '100.00');

    const result = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'USD' },
      }),
    );

    expect(result.transaction.failureCode).toBe(FailureCode.CurrencyMismatch);
  });

  it('wallet inexistente não vira registro auditável', async () => {
    // A transação referencia a wallet, então não há onde persistir.
    const error = await h.submit
      .execute(
        submitInput({
          walletId: '00000000-0000-7000-8000-000000000999',
          kind: WagerTransactionKind.Bet,
        }),
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WalletNotFoundError);
  });

  it('recusa OPENING submetido de fora', async () => {
    const wallet = await openWallet(h, '100.00');

    const error = await h.submit
      .execute(
        submitInput({
          walletId: wallet.id,
          kind: WagerTransactionKind.Opening,
        }),
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InternalKindNotAllowedError);
  });
});

describe('idempotência', () => {
  it('requisição idêntica devolve o resultado original sem duplicar o débito', async () => {
    const wallet = await openWallet(h, '100.00');
    const input = submitInput({
      walletId: wallet.id,
      kind: WagerTransactionKind.Bet,
      amount: '25.00',
    });

    const first = await h.submit.execute(input);
    const second = await h.submit.execute(input);

    expect(second.idempotentReplay).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(second.balance.toString()).toBe('75.00');
    expect(wallet.balance.toString()).toBe('75.00');
    expect(
      h.ledger.entries.filter((e) => e.transactionId === first.transaction.id),
    ).toHaveLength(2);
    expect(h.metrics.idempotentReplays).toBe(1);
  });

  it('o replay devolve o saldo observado na época, não o atual', async () => {
    const wallet = await openWallet(h, '100.00');
    const input = submitInput({
      walletId: wallet.id,
      kind: WagerTransactionKind.Bet,
      amount: '25.00',
    });

    await h.submit.execute(input);
    await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Win,
        amount: '50.00',
      }),
    );
    expect(wallet.balance.toString()).toBe('125.00');

    const replay = await h.submit.execute(input);
    expect(replay.balance.toString()).toBe('75.00');
  });

  it('replay de uma rejeição devolve a rejeição original', async () => {
    const wallet = await openWallet(h, '10.00');
    const input = submitInput({
      walletId: wallet.id,
      kind: WagerTransactionKind.Bet,
      amount: '25.00',
    });

    await h.submit.execute(input);
    const replay = await h.submit.execute(input);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(replay.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  it('replay de LOSS devolve o saldo observado', async () => {
    const wallet = await openWallet(h, '100.00');
    const input = submitInput({
      walletId: wallet.id,
      kind: WagerTransactionKind.Loss,
      amount: '25.00',
    });

    await h.submit.execute(input);
    const replay = await h.submit.execute(input);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.toString()).toBe('100.00');
  });

  it('mesma key com payload diferente é conflito, não replay', async () => {
    const wallet = await openWallet(h, '100.00');
    const base = submitInput({
      walletId: wallet.id,
      kind: WagerTransactionKind.Bet,
      amount: '25.00',
    });

    await h.submit.execute(base);

    const error = await h.submit
      .execute({ ...base, money: { amount: '99.00', currency: 'BRL' } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect(h.metrics.idempotencyConflicts).toBe(1);
    expect(wallet.balance.toString()).toBe('75.00');
  });

  it('key nova para um externalTransactionId já usado é conflito', async () => {
    const wallet = await openWallet(h, '100.00');
    const base = submitInput({
      walletId: wallet.id,
      kind: WagerTransactionKind.Bet,
      amount: '25.00',
      externalTransactionId: 'tx-fixo',
    });

    await h.submit.execute(base);

    const error = await h.submit
      .execute({ ...base, idempotencyKey: 'outra-key-qualquer' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdempotencyConflictError);
  });

  it('reenviar uma PENDING_REFERENCE devolve o estado pendente', async () => {
    const wallet = await openWallet(h, '100.00');
    const input = submitInput({
      walletId: wallet.id,
      kind: WagerTransactionKind.Rollback,
      amount: '25.00',
      referenceExternalTransactionId: 'ainda-nao-chegou',
    });

    const first = await h.submit.execute(input);
    const replay = await h.submit.execute(input);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(replay.transaction.status).toBe(
      WagerTransactionStatus.PendingReference,
    );
    // Reenvio não conta como nova tentativa de reprocessamento.
    expect(replay.transaction.attempts).toBe(1);
  });
});

describe('métricas', () => {
  it('conta transações por status e tipo', async () => {
    const wallet = await openWallet(h, '30.00');

    await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
      }),
    );
    await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
      }),
    );

    expect(h.metrics.transactions).toEqual([
      {
        status: WagerTransactionStatus.Processed,
        kind: WagerTransactionKind.Bet,
      },
      {
        status: WagerTransactionStatus.Rejected,
        kind: WagerTransactionKind.Bet,
      },
    ]);
  });
});

describe('invariante do ledger', () => {
  it('uma sequência completa de operações mantém saldo igual ao ledger', async () => {
    const wallet = await openWallet(h, '100.00');

    await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Bet,
        amount: '30.00',
        externalTransactionId: 'bet-1',
      }),
    );
    await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Win,
        amount: '12.00',
      }),
    );
    await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Loss,
        amount: '5.00',
      }),
    );
    await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Refund,
        amount: '30.00',
        referenceExternalTransactionId: 'bet-1',
      }),
    );

    const account = await h.accounts.findForWallet(wallet.id);
    const aggregate = await h.ledger.aggregateByAccount(
      account?.id ?? '',
      'BRL',
    );

    expect(wallet.balance.toString()).toBe('112.00');
    expect(aggregate.signedSum.toString()).toBe(wallet.balance.toString());
    expect(ledgerImbalance(h)).toBe('0.00');
  });

  it('provedores diferentes não colidem no mesmo externalTransactionId', async () => {
    const wallet = await openWallet(h, '100.00');

    const first = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Bet,
        amount: '10.00',
        providerId: PROVIDER,
        externalTransactionId: 'tx-compartilhado',
      }),
    );
    const second = await h.submit.execute(
      submitInput({
        walletId: wallet.id,
        kind: WagerTransactionKind.Bet,
        amount: '10.00',
        providerId: 'provider-b',
        externalTransactionId: 'tx-compartilhado',
      }),
    );

    expect(first.transaction.id).not.toBe(second.transaction.id);
    expect(wallet.balance.toString()).toBe('80.00');
  });
});
