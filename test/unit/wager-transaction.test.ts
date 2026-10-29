import { describe, expect, it } from 'bun:test';
import {
  FailureCode,
  InternalKindNotAllowedError,
  InvalidTransactionStateError,
  LedgerDirection,
  MissingReferenceError,
  Money,
  UndefinedLedgerDirectionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@wagering/domain';

const AT = new Date('2026-07-29T15:00:00.000Z');
const LATER = new Date('2026-07-29T15:01:00.000Z');
const money = Money.from({ amount: '25.00', currency: 'BRL' });

const create = (
  kind: WagerTransactionKind,
  referenceExternalTransactionId?: string,
): WagerTransaction =>
  WagerTransaction.create({
    id: 't1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: 'a'.repeat(64),
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money,
    referenceExternalTransactionId,
    createdAt: AT,
  });

describe('create', () => {
  it('nasce em PENDING', () => {
    expect(create(WagerTransactionKind.Bet).status).toBe(
      WagerTransactionStatus.Pending,
    );
  });

  it('recusa OPENING submetido de fora', () => {
    // OPENING é interno e não pode ser submetido de fora.
    expect(() => create(WagerTransactionKind.Opening)).toThrow(
      InternalKindNotAllowedError,
    );
  });

  it.each([[WagerTransactionKind.Refund], [WagerTransactionKind.Rollback]])(
    '%s exige referência',
    (kind) => {
      expect(() => create(kind)).toThrow(MissingReferenceError);
      expect(create(kind, 'transaction-100').requiresReference()).toBe(true);
    },
  );

  it.each([
    [WagerTransactionKind.Bet],
    [WagerTransactionKind.Win],
    [WagerTransactionKind.Loss],
  ])('%s não exige referência', (kind) => {
    expect(create(kind).requiresReference()).toBe(false);
  });
});

describe('opening', () => {
  it('é a única porta para o kind OPENING e nasce PROCESSED', () => {
    const opening = WagerTransaction.opening({
      id: 't-open',
      walletId: 'w1',
      playerId: 'p1',
      money,
      payloadHash: 'b'.repeat(64),
      at: AT,
    });

    expect(opening.kind).toBe(WagerTransactionKind.Opening);
    expect(opening.status).toBe(WagerTransactionStatus.Processed);
    expect(opening.isTerminal()).toBe(true);
    expect(opening.idempotencyKey).toBe('internal:opening:w1');
  });
});

describe('transições', () => {
  it('markProcessed registra referência e momento', () => {
    const tx = create(WagerTransactionKind.Bet);
    tx.markProcessed(undefined, LATER);

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.processedAt).toBe(LATER);
  });

  it('markPendingReference incrementa tentativas', () => {
    const tx = create(WagerTransactionKind.Refund, 'transaction-100');

    tx.markPendingReference(LATER);
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.attempts).toBe(1);

    tx.markPendingReference(LATER);
    expect(tx.attempts).toBe(2);
  });

  it('PENDING_REFERENCE ainda pode ser processada ou rejeitada', () => {
    const processed = create(WagerTransactionKind.Refund, 'transaction-100');
    processed.markPendingReference(LATER);
    processed.markProcessed('t-ref', LATER);
    expect(processed.status).toBe(WagerTransactionStatus.Processed);

    const rejected = create(WagerTransactionKind.Refund, 'transaction-100');
    rejected.markPendingReference(LATER);
    rejected.reject(FailureCode.ReferenceNotFound, LATER);
    expect(rejected.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  const terminals: [string, (tx: WagerTransaction) => void][] = [
    ['PROCESSED', (tx) => tx.markProcessed(undefined, LATER)],
    ['REJECTED', (tx) => tx.reject(FailureCode.InsufficientFunds, LATER)],
    ['FAILED', (tx) => tx.fail(FailureCode.WalletNotFound, LATER)],
  ];

  it.each(terminals)(
    '%s é terminal e não aceita nova transição',
    (_label, reachTerminal) => {
      // Tentar transicionar a partir de um terminal é erro de
      // programação, não caminho de negócio.
      const tx = create(WagerTransactionKind.Bet);
      reachTerminal(tx);

      expect(tx.isTerminal()).toBe(true);
      expect(() => tx.markProcessed(undefined, LATER)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.reject(FailureCode.InsufficientFunds, LATER)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.fail(FailureCode.WalletNotFound, LATER)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.markPendingReference(LATER)).toThrow(
        InvalidTransactionStateError,
      );
    },
  );
});

describe('consultas de domínio', () => {
  it('affectsBalance é falso só para LOSS', () => {
    expect(create(WagerTransactionKind.Loss).affectsBalance()).toBe(false);
    expect(create(WagerTransactionKind.Bet).affectsBalance()).toBe(true);
    expect(create(WagerTransactionKind.Win).affectsBalance()).toBe(true);
  });

  it('matchesPayload distingue replay de conflito', () => {
    const tx = create(WagerTransactionKind.Bet);

    expect(tx.matchesPayload('a'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('c'.repeat(64))).toBe(false);
  });

  it.each([
    [WagerTransactionKind.Bet, LedgerDirection.Debit],
    [WagerTransactionKind.Win, LedgerDirection.Credit],
    [WagerTransactionKind.Refund, LedgerDirection.Credit],
  ])('ledgerDirectionFor(%s) é %s', (kind, expected) => {
    expect(create(kind, 'transaction-100').ledgerDirectionFor()).toBe(expected);
  });

  it('ROLLBACK inverte a direção da referência', () => {
    const rollback = create(WagerTransactionKind.Rollback, 'transaction-100');

    expect(rollback.ledgerDirectionFor(create(WagerTransactionKind.Bet))).toBe(
      LedgerDirection.Credit,
    );
    expect(rollback.ledgerDirectionFor(create(WagerTransactionKind.Win))).toBe(
      LedgerDirection.Debit,
    );
  });

  it('ROLLBACK sem referência não tem direção', () => {
    expect(() =>
      create(WagerTransactionKind.Rollback, 'x').ledgerDirectionFor(),
    ).toThrow(MissingReferenceError);
  });

  it('LOSS não produz lançamento', () => {
    expect(() =>
      create(WagerTransactionKind.Loss).ledgerDirectionFor(),
    ).toThrow(UndefinedLedgerDirectionError);
  });
});
