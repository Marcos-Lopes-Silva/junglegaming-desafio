import type { LoggerOptions } from 'pino';

/**
 * `redact` tira dos logs o corpo da requisição, os headers de autenticação e
 * os valores monetários.
 */
export function buildLoggerOptions(
  env: NodeJS.ProcessEnv = process.env,
): LoggerOptions {
  return {
    level: env.LOG_LEVEL ?? 'info',
    messageKey: 'message',
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["idempotency-key"]',
        'req.body',
        'res.body',
        '*.money',
        '*.balance',
      ],
      remove: true,
    },
  };
}
