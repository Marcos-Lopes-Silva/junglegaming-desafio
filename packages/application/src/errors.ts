import { DomainError } from '@wagering/domain';

export class WalletNotFoundError extends DomainError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`a wallet already exists for player ${playerId} in ${currency}`);
  }
}

/**
 * Mesma chave de idempotência com payload diferente. Responder como replay
 * faria o provedor achar que a segunda requisição foi aplicada.
 */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_PAYLOAD_MISMATCH';

  constructor(idempotencyKey: string) {
    super(
      `idempotency key ${idempotencyKey} was already used with a different payload`,
    );
  }
}

export class WagerTransactionNotFoundError extends DomainError {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(reference: string) {
    super(`wager transaction ${reference} not found`);
  }
}

export class InvalidLedgerCursorError extends DomainError {
  readonly code = 'INVALID_LEDGER_CURSOR';

  constructor() {
    super('the provided ledger cursor is not valid');
  }
}
