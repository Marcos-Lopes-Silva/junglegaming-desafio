import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../common/public.decorator.js';

/**
 * Libera todas as rotas: autenticação não foi implementada. Para autenticar,
 * troque este guard por um que valide o JWT e implemente o
 * `ProviderIdentityPort`.
 */
@Injectable()
export class NoopAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Já lê o @Public() para as rotas públicas continuarem abertas quando a
    // autenticação for implementada.
    this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    return true;
  }
}
