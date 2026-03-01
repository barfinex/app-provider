import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@barfinex/config';

@Injectable()
export class ProviderApiTokenGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      method?: string;
      headers?: Record<string, string | string[] | undefined>;
    }>();

    // Let CORS preflight pass; actual API call is still protected.
    if ((request.method || '').toUpperCase() === 'OPTIONS') {
      return true;
    }

    const providerConfig = this.configService.getConfig()?.provider as
      | { apiToken?: string }
      | undefined;
    const expectedToken = (providerConfig?.apiToken || '').trim();
    if (!expectedToken) {
      throw new UnauthorizedException('Provider API token is not configured');
    }

    const rawAuthorization = request.headers?.authorization;
    const authorization = Array.isArray(rawAuthorization)
      ? rawAuthorization[0]
      : rawAuthorization || '';
    const rawApiToken = request.headers?.['x-api-token'];
    const apiTokenHeader = Array.isArray(rawApiToken) ? rawApiToken[0] : rawApiToken || '';

    const extractedAuthToken = authorization.toLowerCase().startsWith('bearer ')
      ? authorization.slice(7).trim()
      : authorization.trim();
    const providedToken = extractedAuthToken || apiTokenHeader.trim();

    if (!providedToken || providedToken !== expectedToken) {
      throw new UnauthorizedException('Invalid provider API token');
    }

    return true;
  }
}
