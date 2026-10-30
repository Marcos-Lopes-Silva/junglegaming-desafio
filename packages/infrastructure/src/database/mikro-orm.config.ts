import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migration0001Initial } from './migrations/Migration0001Initial.js';
import { Migration0002ObservedBalance } from './migrations/Migration0002ObservedBalance.js';
import { Migration0003Inbox } from './migrations/Migration0003Inbox.js';
import { ENTITY_SCHEMAS } from './schemas.js';

export interface DatabaseOptions {
  clientUrl: string;
  poolMax?: number;
  debug?: boolean;
}

export function readDatabaseOptions(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseOptions {
  const clientUrl = env.DATABASE_URL;
  if (!clientUrl) {
    throw new Error('DATABASE_URL is required');
  }
  return {
    clientUrl,
    poolMax: env.DATABASE_POOL_MAX ? Number(env.DATABASE_POOL_MAX) : 20,
    debug: env.DATABASE_DEBUG === 'true',
  };
}

/**
 * `migrationsList` lista as migrations à mão: a descoberta por glob do
 * MikroORM espera arquivos compilados ou ts-node, e assim o `@mikro-orm/cli`
 * não é necessário.
 */
export function buildOrmConfig(options: DatabaseOptions) {
  return defineConfig({
    clientUrl: options.clientUrl,
    entities: ENTITY_SCHEMAS,
    extensions: [Migrator],
    debug: options.debug ?? false,
    forceUtcTimezone: true,
    allowGlobalContext: false,
    pool: { min: 2, max: options.poolMax ?? 20 },
    migrations: {
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      disableForeignKeys: false,
      // As migrations são SQL escrito à mão, não geradas por diff de schema.
      snapshot: false,
      migrationsList: [
        { name: 'Migration0001Initial', class: Migration0001Initial },
        {
          name: 'Migration0002ObservedBalance',
          class: Migration0002ObservedBalance,
        },
        { name: 'Migration0003Inbox', class: Migration0003Inbox },
      ],
    },
  });
}
