import { DomainError } from '../errors/domain-error.js';
import type { Money } from '../money/money.js';

/**
 * Saldo insuficiente para o débito.
 *
 * O erro só descreve a falta de saldo: como reportá-la fica a cargo de quem
 * chama, porque o mesmo débito recusado pode significar coisas diferentes
 * dependendo da operação que o originou.
 */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(
    readonly available: Money,
    readonly requested: Money,
  ) {
    super(
      `insufficient funds: available ${available.toString()}, requested ${requested.toString()}`,
    );
  }
}
