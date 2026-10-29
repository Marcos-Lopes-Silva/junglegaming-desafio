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

export class InvalidLedgerCursorError extends DomainError {
  readonly code = 'INVALID_LEDGER_CURSOR';

  constructor() {
    super('the provided ledger cursor is not valid');
  }
}
