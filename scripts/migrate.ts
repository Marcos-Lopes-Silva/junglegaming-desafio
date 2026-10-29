/**
 * Runner de migrations.
 *
 * Usa a API do Migrator direto, sem o `@mikro-orm/cli`, que precisaria de
 * ts-node ou de arquivos compilados para ler as migrations em TypeScript.
 *
 *   bun scripts/migrate.ts up | down | list
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig, readDatabaseOptions } from '@wagering/infrastructure';

const command = process.argv[2] ?? 'up';

const orm = await MikroORM.init(buildOrmConfig(readDatabaseOptions()));
const migrator = orm.migrator;

try {
  switch (command) {
    case 'up': {
      const applied = await migrator.up();
      console.log(
        applied.length === 0
          ? 'no pending migrations'
          : `applied: ${applied.map((m) => m.name).join(', ')}`,
      );
      break;
    }
    case 'down': {
      const reverted = await migrator.down();
      console.log(
        reverted.length === 0
          ? 'nothing to revert'
          : `reverted: ${reverted.map((m) => m.name).join(', ')}`,
      );
      break;
    }
    case 'list': {
      const executed = await migrator.getExecuted();
      const pending = await migrator.getPending();
      console.log(`executed: ${executed.map((m) => m.name).join(', ') || '-'}`);
      console.log(`pending:  ${pending.map((m) => m.name).join(', ') || '-'}`);
      break;
    }
    default:
      console.error(
        `unknown command "${command}" (expected: up | down | list)`,
      );
      process.exitCode = 1;
  }
} finally {
  await orm.close(true);
}
