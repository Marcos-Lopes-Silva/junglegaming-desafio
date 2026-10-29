/**
 * O domínio não conhece HTTP nem NestJS: `code` identifica o erro e a
 * tradução para status fica a cargo de quem consome o domínio.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Tentativa de transicionar um agregado a partir de um estado terminal.
 *
 * Indica bug no código, não regra de negócio, e não deve virar rejeição para o
 * provedor.
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(from: string, attempted: string) {
    super(
      `cannot apply "${attempted}" to a transaction in terminal state "${from}"`,
    );
  }
}
