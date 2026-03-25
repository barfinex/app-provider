import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@barfinex/config';

type ProviderAuthConfig = { apiToken?: string; allowAnonymousInDev?: boolean };

@Injectable()
export class ProviderApiTokenGuard implements CanActivate {
  private static readonly PUBLIC_HEALTH_PATHS = new Set([
    '/health/live',
    '/health/ready',
    '/provider/runtime/ws',
  ]);

  private readonly logger = new Logger(ProviderApiTokenGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      method?: string;
      url?: string;
      path?: string;
      headers?: Record<string, string | string[] | undefined>;
    }>();

    // Let CORS preflight pass; actual API call is still protected.
    if ((request.method || '').toUpperCase() === 'OPTIONS') {
      return true;
    }

    const requestPath = this.normalizePath(request.path || request.url || '');
    if (ProviderApiTokenGuard.PUBLIC_HEALTH_PATHS.has(requestPath)) {
      return true;
    }

    const providerConfig = this.configService.getConfig()?.provider as
      | ProviderAuthConfig
      | undefined;
    const expectedToken = (providerConfig?.apiToken || '').trim();
    const allowAnonymousInDev =
      providerConfig?.allowAnonymousInDev === true ||
      process.env.PROVIDER_ALLOW_ANONYMOUS_IN_DEV === 'true';
    const isDev = process.env.NODE_ENV !== 'production';
    const allowAnonymous = isDev && allowAnonymousInDev;

    const rawAuthorization = request.headers?.authorization;
    const authorization = Array.isArray(rawAuthorization)
      ? rawAuthorization[0]
      : rawAuthorization || '';
    const rawApiToken = request.headers?.['x-api-token'];
    const apiTokenHeader = Array.isArray(rawApiToken)
      ? rawApiToken[0]
      : rawApiToken || '';

    const extractedAuthToken = authorization.toLowerCase().startsWith('bearer ')
      ? authorization.slice(7).trim()
      : authorization.trim();
    const providedToken = extractedAuthToken || apiTokenHeader.trim();

    if (!providedToken) {
      if (allowAnonymous) {
        this.logger.debug('[AUTH] Anonymous request allowed (DEV)');
        return true;
      }
      throw new UnauthorizedException('Invalid provider API token');
    }

    if (!expectedToken) {
      throw new UnauthorizedException('Provider API token is not configured');
    }
    if (providedToken !== expectedToken) {
      throw new UnauthorizedException('Invalid provider API token');
    }

    return true;
  }

  private normalizePath(path: string): string {
    const withoutQuery = path.split('?')[0] || '';
    const normalized =
      withoutQuery.endsWith('/') && withoutQuery.length > 1
        ? withoutQuery.slice(0, -1)
        : withoutQuery;
    return normalized || '/';
  }
}
