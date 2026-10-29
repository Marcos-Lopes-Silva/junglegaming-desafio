import {
  DomainError,
  InvalidTransactionStateError,
} from '../errors/domain-error.js';
import { Money, type MoneyProps } from '../money/money.js';
import { LedgerDirection } from '../wallet/ledger-entry.js';
import { FailureCode } from './failure-code.js';

export enum WagerTransactionKind {
  /** interno: crédito de abertura da wallet */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** aceita, ainda não aplicada */
  Pending = 'PENDING',
  /** aguardando a transação referenciada */
  PendingReference = 'PENDING_REFERENCE',
  /** aplicada (terminal) */
  Processed = 'PROCESSED',
  /** violação de regra de negócio (terminal) */
  Rejected = 'REJECTED',
  /** erro permanente de infraestrutura (terminal, auditável) */
  Failed = 'FAILED',
}

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

const KINDS_REQUIRING_REFERENCE: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

export class InternalKindNotAllowedError extends DomainError {
  readonly code = FailureCode.InternalKindNotAllowed;

  constructor() {
    super(
      'OPENING transactions are internal and cannot be submitted externally',
    );
  }
}

export class MissingReferenceError extends DomainError {
  readonly code = FailureCode.ReferenceRequired;

  constructor(kind: WagerTransactionKind) {
    super(`${kind} requires referenceExternalTransactionId`);
  }
}

export class UndefinedLedgerDirectionError extends DomainError {
  readonly code = 'UNDEFINED_LEDGER_DIRECTION';

  constructor(kind: WagerTransactionKind) {
    super(`${kind} does not produce a ledger entry`);
  }
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  attempts: number;
  nextAttemptAt: Date | undefined;
  observedBalance: MoneyProps | undefined;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor, não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _attempts: number = 0,
    private _nextAttemptAt?: Date,
    /**
     * Saldo da wallet no instante em que a transação virou terminal. Gravado para o
     * replay devolver o resultado original mesmo para `LOSS`, rejeições e
     * `PENDING_REFERENCE`, que não têm `balanceAfter` de onde derivá-lo.
     */
    private _observedBalance?: Money,
  ) {}

  /**
   * Nasce em PENDING. Valida a exigência de referência por kind e recusa
   * `OPENING`, que é interno.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InternalKindNotAllowedError();
    }
    if (
      KINDS_REQUIRING_REFERENCE.has(props.kind) &&
      !props.referenceExternalTransactionId
    ) {
      throw new MissingReferenceError(props.kind);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  /**
   * Crédito de abertura da wallet. Nasce PROCESSED porque é aplicado junto com
   * a criação da wallet; é a única porta para o kind `OPENING`.
   */
  static opening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    at: Date;
  }): WagerTransaction {
    return new WagerTransaction(
      props.id,
      'internal',
      `opening:${props.walletId}`,
      `internal:opening:${props.walletId}`,
      props.payloadHash,
      props.walletId,
      props.playerId,
      `opening:${props.walletId}`,
      'internal',
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.at,
      WagerTransactionStatus.Processed,
      undefined,
      undefined,
      props.at,
      0,
      undefined,
      props.money,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.rehydrate(state.money),
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.attempts,
      state.nextAttemptAt,
      state.observedBalance
        ? Money.rehydrate(state.observedBalance)
        : undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  // Todas recebem o saldo observado: é o que permite ao replay devolver a
  // resposta original em vez do saldo atual.

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    observedBalance?: Money,
  ): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
    this._observedBalance = observedBalance;
  }

  /** Referência ausente: fica aguardando um novo reprocessamento. */
  markPendingReference(nextAttemptAt?: Date, observedBalance?: Money): void {
    this.assertNotTerminal('markPendingReference');
    this._status = WagerTransactionStatus.PendingReference;
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt;
    this._observedBalance = observedBalance ?? this._observedBalance;
  }

  reject(code: FailureCode, at: Date, observedBalance?: Money): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
    this._observedBalance = observedBalance ?? this._observedBalance;
  }

  fail(code: FailureCode, at: Date, observedBalance?: Money): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
    this._observedBalance = observedBalance ?? this._observedBalance;
  }

  attachReference(referenceTransactionId: string): void {
    this._referenceTransactionId = referenceTransactionId;
  }

  private assertNotTerminal(attempted: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, attempted);
    }
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** `LOSS` registra o resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return KINDS_REQUIRING_REFERENCE.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento na conta da wallet.
   *
   * `ROLLBACK` inverte a direção da referência; os demais kinds têm direção
   * fixa. `LOSS` não produz lançamento e por isso lança.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new MissingReferenceError(this.kind);
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Credit
          ? LedgerDirection.Debit
          : LedgerDirection.Credit;
      }
      case WagerTransactionKind.Loss:
        throw new UndefinedLedgerDirectionError(this.kind);
    }
  }
}
