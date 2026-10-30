/**
 * Orquestra a suíte de integração: sobe Postgres e LocalStack reais, aplica as
 * migrations e roda os testes e2e.
 *
 * Usa containers reais porque mocks de PostgreSQL e SQS não testariam locks,
 * constraints e redelivery.
 */
export {};

const TEST_DATABASE_URL =
  'postgresql://wagering:wagering@localhost:55432/wagering_test';
const TEST_SQS_ENDPOINT = 'http://localhost:44566';

const COMPOSE = ['docker', 'compose', '-f', 'docker-compose.test.yml'];
const keepUp = process.argv.includes('--keep-up');

async function run(
  cmd: string[],
  env: Record<string, string> = {},
): Promise<number> {
  const proc = Bun.spawn(cmd, {
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, ...env },
  });
  return proc.exited;
}

console.log('→ starting test containers');
if ((await run([...COMPOSE, 'up', '-d', '--wait'])) !== 0) {
  console.error('failed to start test containers');
  process.exit(1);
}

let exitCode = 1;
try {
  console.log('→ applying migrations');
  if (
    (await run(['bun', 'scripts/migrate.ts', 'up'], {
      DATABASE_URL: TEST_DATABASE_URL,
    })) !== 0
  ) {
    throw new Error('migrations failed');
  }

  console.log('→ running e2e suite');
  exitCode = await run(['bun', 'test', 'test/e2e'], {
    DATABASE_URL: TEST_DATABASE_URL,
    AWS_SQS_ENDPOINT: TEST_SQS_ENDPOINT,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    LOG_LEVEL: 'silent',
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  if (keepUp) {
    console.log('→ leaving test containers up (--keep-up)');
  } else {
    console.log('→ tearing down test containers');
    await run([...COMPOSE, 'down', '-v']);
  }
}

process.exit(exitCode);
