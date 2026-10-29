/**
 * Códigos de falha devolvidos ao provedor, que decide por eles se reenvia,
 * corrige o payload ou desiste.
 *
 * `INSUFFICIENT_FUNDS` é uma aposta sem saldo. `INSUFFICIENT_FUNDS_FOR_REVERSAL`
 * é uma reversão sem saldo, o que indica inconsistência e precisa ser
 * investigado.
 */
export enum FailureCode {
  /** Aposta sem saldo. O provedor pode reenviar depois de um crédito. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** Reversão que deixaria a wallet negativa. Não adianta reenviar. */
  InsufficientFundsForReversal = 'INSUFFICIENT_FUNDS_FOR_REVERSAL',

  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',

  ReferenceRequired = 'REFERENCE_REQUIRED',
  /** Referência não apareceu dentro do TTL. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceKindNotReversible = 'REFERENCE_KIND_NOT_REVERSIBLE',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** Referência existe mas é de outro provider, player, wallet, moeda ou rodada. */
  ReferenceScopeMismatch = 'REFERENCE_SCOPE_MISMATCH',

  /** `OPENING` submetido de fora: o kind é interno. */
  InternalKindNotAllowed = 'INTERNAL_KIND_NOT_ALLOWED',
  IdempotencyPayloadMismatch = 'IDEMPOTENCY_PAYLOAD_MISMATCH',
}
