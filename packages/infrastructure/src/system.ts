import type {
  ClockPort,
  IdGeneratorPort,
  ProviderIdentityPort,
} from '@wagering/application';
import { v7 as uuidv7 } from 'uuid';

export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}

/** UUIDv7: ordenável por tempo, o que dá localidade ao índice do cursor. */
export class Uuidv7Generator implements IdGeneratorPort {
  next(): string {
    return uuidv7();
  }
}

/**
 * Sem autenticação, confia no `providerId` do payload. Com OIDC, a identidade
 * viria do token.
 */
export class TrustedPayloadProviderIdentity implements ProviderIdentityPort {
  resolve(claimedProviderId: string): Promise<string> {
    return Promise.resolve(claimedProviderId);
  }
}
