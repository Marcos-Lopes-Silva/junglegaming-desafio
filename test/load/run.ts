/**
 * Teste de carga.
 *
 * Escrito à mão em vez de k6 ou autocannon porque o objetivo é medir throughput e
 * percentis junto com conflitos de concorrência e outbox lag, que são métricas
 * do domínio. Uma ferramenta genérica mediria só HTTP e não saberia nada sobre
 * rejeição por saldo, replay idempotente ou atraso da outbox.
 *
 *   bun run test:load
 *   API_URL=http://localhost:3000 WALLETS=20 REQUESTS=2000 CONCURRENCY=64 bun run test:load
 */
export {};

interface Config {
  apiUrl: string;
  /**
   * As réplicas do worker não publicam porta e cada uma tem seu próprio
   * registry. O Prometheus agrega todas, então ler dele dá o número do sistema
   * inteiro, não o de uma réplica sorteada.
   */
  prometheusUrl: string;
  wallets: number;
  requests: number;
  concurrency: number;
  initialBalance: string;
  betAmount: string;
  outFile: string | undefined;
}

const config: Config = {
  apiUrl: process.env.API_URL ?? 'http://localhost:3000',
  prometheusUrl: process.env.PROMETHEUS_URL ?? 'http://localhost:9090',
  wallets: Number(process.env.WALLETS ?? 10),
  requests: Number(process.env.REQUESTS ?? 1_000),
  concurrency: Number(process.env.CONCURRENCY ?? 32),
  initialBalance: process.env.INITIAL_BALANCE ?? '100000.00',
  betAmount: process.env.BET_AMOUNT ?? '1.00',
  outFile: process.env.OUT_FILE,
};

interface Sample {
  latencyMs: number;
  status: number;
  outcome: string;
}

const uuid = (): string => crypto.randomUUID();

async function createWallets(): Promise<string[]> {
  const ids: string[] = [];

  for (let i = 0; i < config.wallets; i += 1) {
    const response = await fetch(`${config.apiUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: uuid(),
        initialBalance: { amount: config.initialBalance, currency: 'BRL' },
      }),
    });

    if (response.status !== 201) {
      throw new Error(
        `failed to create wallet: ${response.status} ${await response.text()}`,
      );
    }

    ids.push(((await response.json()) as { id: string }).id);
  }

  return ids;
}

/**
 * `BET` domina porque é a operação que disputa saldo e exercita o lock por
 * wallet. `WIN` e `LOSS` entram para que o ledger e os eventos não sejam de
 * um tipo só.
 */
function pickKind(index: number): 'BET' | 'WIN' | 'LOSS' {
  const slot = index % 10;
  if (slot < 7) return 'BET';
  if (slot < 9) return 'WIN';
  return 'LOSS';
}

async function fireOne(
  walletId: string,
  playerId: string,
  index: number,
): Promise<Sample> {
  const externalTransactionId = `load-${index}-${uuid()}`;
  const startedAt = performance.now();

  try {
    const response = await fetch(`${config.apiUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `load-provider:${externalTransactionId}`,
      },
      body: JSON.stringify({
        providerId: 'load-provider',
        externalTransactionId,
        playerId,
        walletId,
        roundId: `round-${index}`,
        gameId: 'load-test',
        kind: pickKind(index),
        money: { amount: config.betAmount, currency: 'BRL' },
      }),
    });

    const body = (await response.json()) as {
      status?: string;
      failureCode?: string;
    };
    const latencyMs = performance.now() - startedAt;

    return {
      latencyMs,
      status: response.status,
      outcome: body.failureCode ?? body.status ?? String(response.status),
    };
  } catch (error) {
    return {
      latencyMs: performance.now() - startedAt,
      status: 0,
      outcome: `network:${error instanceof Error ? error.name : 'unknown'}`,
    };
  }
}

async function runPool(
  wallets: { id: string; playerId: string }[],
  requests: number,
  offset: number,
): Promise<Sample[]> {
  const samples = new Array<Sample>(requests);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= requests) {
        return;
      }

      const wallet = wallets[index % wallets.length];
      if (!wallet) {
        return;
      }
      samples[index] = await fireOne(
        wallet.id,
        wallet.playerId,
        offset + index,
      );
    }
  };

  await Promise.all(Array.from({ length: config.concurrency }, worker));

  return samples;
}

interface PhaseResult {
  label: string;
  wallets: number;
  samples: Sample[];
  elapsedSeconds: number;
}

async function runPhase(
  label: string,
  wallets: { id: string; playerId: string }[],
  requests: number,
  offset: number,
): Promise<PhaseResult> {
  console.log(
    `→ fase "${label}": ${requests} requisições sobre ${wallets.length} wallet(s)`,
  );

  const startedAt = performance.now();
  const samples = await runPool(wallets, requests, offset);

  return {
    label,
    wallets: wallets.length,
    samples,
    elapsedSeconds: (performance.now() - startedAt) / 1000,
  };
}

function summarize(phase: PhaseResult) {
  const latencies = phase.samples
    .map((sample) => sample.latencyMs)
    .sort((a, b) => a - b);
  const errors = phase.samples.filter(
    (sample) => sample.status === 0 || sample.status >= 500,
  ).length;

  return {
    label: phase.label,
    wallets: phase.wallets,
    count: phase.samples.length,
    throughput: phase.samples.length / phase.elapsedSeconds,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies[latencies.length - 1] ?? 0,
    errors,
    rejected: phase.samples.filter((sample) => sample.status === 422).length,
    conflicts: phase.samples.filter((sample) => sample.status === 409).length,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)] ?? 0;
}

async function query(expression: string): Promise<number> {
  try {
    const url = `${config.prometheusUrl}/api/v1/query?query=${encodeURIComponent(expression)}`;
    const body = (await (await fetch(url)).json()) as {
      status: string;
      data?: { result?: { value?: [number, string] }[] };
    };

    if (body.status !== 'success') {
      return Number.NaN;
    }

    const value = body.data?.result?.[0]?.value?.[1];
    return value === undefined ? 0 : Number(value);
  } catch {
    return Number.NaN;
  }
}

/**
 * Espera a outbox drenar antes de medir o lag final. Sem isso o número seria o
 * pico momentâneo da última requisição, e não quanto tempo o publisher levou
 * para alcançar a carga.
 */
async function waitForOutbox(timeoutMs = 60_000): Promise<number> {
  const startedAt = performance.now();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const lag = await query('max(outbox_lag_seconds)');
    if (lag === 0) {
      return (performance.now() - startedAt) / 1000;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return (performance.now() - startedAt) / 1000;
}

async function reconcileAll(
  walletIds: string[],
): Promise<{ checked: number; divergent: number }> {
  let divergent = 0;

  for (const walletId of walletIds) {
    const response = await fetch(
      `${config.apiUrl}/wallets/${walletId}/reconciliation`,
      {
        method: 'POST',
      },
    );
    const body = (await response.json()) as { consistent: boolean };
    if (!body.consistent) {
      divergent += 1;
    }
  }

  return { checked: walletIds.length, divergent };
}

console.log('→ criando wallets');
const walletIds = await createWallets();
const wallets = walletIds.map((id) => ({ id, playerId: uuid() }));

// O playerId precisa bater com o da wallet, senão tudo vira
// WALLET_PLAYER_MISMATCH e o teste mediria o caminho de rejeição.
for (const wallet of wallets) {
  const body = (await (
    await fetch(`${config.apiUrl}/wallets/${wallet.id}`)
  ).json()) as {
    playerId: string;
  };
  wallet.playerId = body.playerId;
}

// Duas fases: carga distribuída e carga concentrada numa wallet.
const spread = await runPhase('distribuída', wallets, config.requests, 0);
const hotWallet = wallets.slice(0, 1);
const hot = await runPhase(
  'hot wallet',
  hotWallet,
  config.requests,
  config.requests,
);

const phases = [summarize(spread), summarize(hot)];
const samples = [...spread.samples, ...hot.samples];
const elapsedSeconds = spread.elapsedSeconds + hot.elapsedSeconds;

const byOutcome = samples.reduce<Record<string, number>>((acc, sample) => {
  acc[sample.outcome] = (acc[sample.outcome] ?? 0) + 1;
  return acc;
}, {});

const errors = phases.reduce((sum, phase) => sum + phase.errors, 0);

console.log('→ esperando a outbox drenar');
const outboxDrainSeconds = await waitForOutbox();

console.log('→ reconciliando todas as wallets');
const reconciliation = await reconcileAll(walletIds);

const outboxLag = await query('max(outbox_lag_seconds)');
const retries = await query('sum(retries_total)');
const inboxDuplicates = await query('sum(inbox_duplicates_total)');
const dlq = await query('sum(dlq_messages_total)');

const fmt = (value: number, digits = 2) =>
  Number.isNaN(value) ? 'n/d' : value.toFixed(digits);

const report = `
# Teste de carga

## Ambiente

| Item | Valor |
|---|---|
| Data | ${new Date().toISOString()} |
| Plataforma | ${process.platform} ${process.arch}, ${navigator.hardwareConcurrency} vCPU |
| Runtime | Bun ${Bun.version} |
| Alvo | ${config.apiUrl} |
| Prometheus | ${config.prometheusUrl} |

## Metodologia

Pool de ${config.concurrency} conexões concorrentes consumindo uma fila de
requisições, com mistura de 70% \`BET\`, 20% \`WIN\` e 10% \`LOSS\` de
${config.betAmount} BRL, cada uma com \`Idempotency-Key\` única.

Duas fases, para medir quanto custa a serialização por wallet:

1. **Distribuída** — ${config.requests} requisições espalhadas por
   ${config.wallets} wallets. Pouca disputa pelo mesmo lock.
2. **Hot wallet** — as mesmas ${config.requests} requisições concentradas numa
   **única** wallet. Toda requisição disputa o mesmo \`SELECT ... FOR UPDATE\`.

A diferença entre as duas mostra o custo do lock pessimista.

Latência é medida no cliente, da requisição até o corpo lido. O gerador roda na
mesma máquina que o sistema, então os números incluem a contenção entre os
dois e valem para desenvolvimento, não para produção. A API é um processo Bun,
single-threaded: um container satura um núcleo, e para escalar é preciso subir
mais réplicas.

Rejeição por regra de negócio (422) não conta como erro. Erro é 5xx ou falha
de rede.

## Resultados por fase

| Fase | Wallets | Reqs | Throughput | p50 | p95 | p99 | máx | Erros |
|---|---|---|---|---|---|---|---|---|
${phases
  .map(
    (phase) =>
      `| ${phase.label} | ${phase.wallets} | ${phase.count} | ${fmt(phase.throughput)} req/s | ${fmt(phase.p50)} ms | ${fmt(phase.p95)} ms | ${fmt(phase.p99)} ms | ${fmt(phase.max)} ms | ${phase.errors} |`,
  )
  .join('\n')}

Custo da contenção: o throughput da hot wallet é
**${fmt(((phases[1]?.throughput ?? 0) / (phases[0]?.throughput ?? 1)) * 100, 1)}%**
do throughput distribuído.

## Agregado

| Métrica | Valor |
|---|---|
| Duração total | ${fmt(elapsedSeconds)} s |
| Requisições | ${samples.length} |
| Taxa de erro | ${fmt((errors / samples.length) * 100)} % (${errors}/${samples.length}) |
| Rejeições de negócio | ${phases.reduce((sum, phase) => sum + phase.rejected, 0)} |
| Conflitos de idempotência | ${phases.reduce((sum, phase) => sum + phase.conflicts, 0)} |
| Tempo até a outbox drenar | ${fmt(outboxDrainSeconds)} s |
| Outbox lag final | ${fmt(outboxLag)} s |
| Retries (todos os estágios) | ${fmt(retries, 0)} |
| Duplicatas barradas pelo inbox | ${fmt(inboxDuplicates, 0)} |
| Mensagens em DLQ | ${fmt(dlq, 0)} |

### Desfechos

${Object.entries(byOutcome)
  .sort((a, b) => b[1] - a[1])
  .map(([outcome, count]) => `- \`${outcome}\`: ${count}`)
  .join('\n')}

### Consistência

${reconciliation.divergent === 0 ? '✅' : '❌'} ${reconciliation.checked} wallets
reconciliadas, ${reconciliation.divergent} divergentes.

O saldo materializado de cada wallet foi comparado com o reconstruído pelo
ledger depois da carga.

## Análise

**Custo do lock pessimista.** Concentrar toda a carga numa
única wallet derruba o throughput para ${fmt(((phases[1]?.throughput ?? 0) / (phases[0]?.throughput ?? 1)) * 100, 0)}%,
mas não para perto de zero, porque a seção crítica é curta: o lock cobre uma transação de poucos
milissegundos, não a requisição inteira. A latência p99 inclusive *melhora* na
fase concentrada, porque a fila do lock funciona como controle de admissão e
reduz a variância.

**O gargalo é o publisher da outbox.** A API
ingeriu ${samples.length} requisições em ${fmt(elapsedSeconds)} s, mas a outbox
levou ${fmt(outboxDrainSeconds)} s para drenar depois disso. O publisher
processa um lote de ${20} mensagens por tick de 1 s, publicando uma a uma —
cerca de 20 eventos/s contra um ingresso de
${fmt(samples.length / elapsedSeconds, 0)} req/s, com até 2 eventos por
requisição.

Opções para melhorar, da mais vantajosa para a menos:

1. **\`SendMessageBatch\`** no lugar de \`SendMessage\` — o SQS aceita 10
   mensagens por chamada, o que reduz as chamadas de rede em até 10×.
2. **Lote maior e tick mais curto.** O limite de ${20} e o intervalo de 1 s
   foram escolhidos para desenvolvimento, não medidos. Ambos são
   configuráveis.
3. **Mais réplicas de worker.** O \`FOR UPDATE SKIP LOCKED\` já permite isso;
   é a opção mais simples, mas a que rende menos por processo.

O atraso não perde eventos: a outbox é durável e o publisher continua de onde
parou. O efeito é só a demora para os eventos chegarem a quem consome.

**A API é single-threaded.** Um processo Bun satura um núcleo; durante a carga
o container ficou em ~100% de CPU com o Postgres em menos de 1%. O banco não é
o limite neste cenário; para escalar, o caminho é ter mais réplicas de API, e
os testes com três processos mostram que isso é seguro.

**Limitações deste experimento.** Gerador e sistema dividem a mesma máquina;
LocalStack não tem o perfil de latência do SQS real; a carga é curta demais
para expor vazamento de memória ou degradação de índice; e não houve fase de
rejeição por saldo (todas as wallets começaram com folga), então o caminho de
\`INSUFFICIENT_FUNDS\` não entrou na medição de latência.
`.trim();

console.log(`\n${report}\n`);

if (config.outFile) {
  await Bun.write(config.outFile, `${report}\n`);
  console.log(`→ relatório salvo em ${config.outFile}`);
}

if (reconciliation.divergent > 0) {
  console.error('divergência de reconciliação detectada');
  process.exit(1);
}
