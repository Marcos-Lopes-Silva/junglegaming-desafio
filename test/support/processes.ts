import type { Subprocess } from 'bun';

export const TEST_ENV = {
  DATABASE_URL: 'postgresql://wagering:wagering@localhost:55432/wagering_test',
  AWS_SQS_ENDPOINT: 'http://localhost:44566',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  LOG_LEVEL: 'silent',
  SQS_WAIT_TIME_SECONDS: '2',
} as const;

export interface SpawnedProcess {
  process: Subprocess;
  kill: () => void;
  terminate: (timeoutMs?: number) => Promise<void>;
  exited: Promise<number>;
  /**
   * Guarda o sinal separado do código de saída: um processo que falha ao subir
   * também sai com código diferente de zero, e um teste que só checasse isso
   * passaria sem testar nada.
   */
  waitForExit: () => Promise<{
    code: number | null;
    signal: NodeJS.Signals | number | null;
  }>;
}

export function spawnProcess(
  entrypoint: string,
  env: Record<string, string> = {},
): SpawnedProcess {
  const process_ = Bun.spawn(['bun', entrypoint], {
    env: { ...process.env, ...TEST_ENV, ...env },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  return {
    process: process_,
    kill: () => process_.kill('SIGKILL'),
    terminate: async (timeoutMs = 15_000) => {
      process_.kill('SIGTERM');
      await Promise.race([
        process_.exited,
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    },
    exited: process_.exited,
    waitForExit: async () => {
      const code = await process_.exited;
      return { code, signal: process_.signalCode };
    },
  };
}

export const spawnApi = (port: number): SpawnedProcess =>
  spawnProcess('apps/api/src/main.ts', { PORT: String(port) });

export const spawnWorker = (
  port: number,
  env: Record<string, string> = {},
): SpawnedProcess =>
  spawnProcess('apps/worker/src/main.ts', {
    WORKER_PORT: String(port),
    ...env,
  });

export async function waitForHttp(
  url: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // ainda subindo
    }
    await sleep(200);
  }

  throw new Error(`${url} did not become ready in ${timeoutMs}ms`);
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 30_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(200);
  }

  throw new Error(`${label} not met within ${timeoutMs}ms`);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let nextPort = 43_100;
export const allocatePort = (): number => (nextPort += 1);
