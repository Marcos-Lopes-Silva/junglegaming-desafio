import type { EntityManager } from '@mikro-orm/postgresql';
import type { TransactionRunnerPort } from '@wagering/application';

/**
 * `em.transactional()` instala a transação no AsyncLocalStorage do MikroORM, e
 * os repositórios que usam o `EntityManager` contextual se juntam a ela. Assim
 * wallet, ledger, transação e outbox commitam juntos.
 */
export class TransactionRunner implements TransactionRunnerPort {
  constructor(private readonly em: EntityManager) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    return this.em.transactional(() => fn());
  }
}
