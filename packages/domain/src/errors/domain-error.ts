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
