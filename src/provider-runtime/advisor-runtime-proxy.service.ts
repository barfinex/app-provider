import { Injectable } from '@nestjs/common';
import {
  AdvisorProxyResult,
  AdvisorProxyService,
} from '../advisor-proxy/advisor-proxy.service';

@Injectable()
export class AdvisorRuntimeProxyService {
  constructor(private readonly advisorProxyService: AdvisorProxyService) {}

  async getStatus(
    headers?: Record<string, unknown>,
  ): Promise<AdvisorProxyResult> {
    return this.advisorProxyService.get('runtime/status', undefined, headers);
  }

  async getGraph(
    headers?: Record<string, unknown>,
  ): Promise<AdvisorProxyResult> {
    return this.advisorProxyService.get('runtime/graph', undefined, headers);
  }
}
