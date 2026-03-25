import { Injectable, Logger } from '@nestjs/common';

export interface BootstrapState {
  httpStarted: boolean;
  connectorsRegistered: boolean;
  detectorsLoaded: boolean;
  ownershipClaimed: boolean;
  subscriptionsReady: boolean;
  runtimeReady: boolean;
}

@Injectable()
export class ProviderBootstrapService {
  private readonly logger = new Logger(ProviderBootstrapService.name);

  private readonly state: BootstrapState = {
    httpStarted: false,
    connectorsRegistered: false,
    detectorsLoaded: false,
    ownershipClaimed: false,
    subscriptionsReady: false,
    runtimeReady: false,
  };

  getState(): BootstrapState {
    return { ...this.state };
  }

  isReady(): boolean {
    return (
      this.state.connectorsRegistered &&
      this.state.detectorsLoaded &&
      this.state.ownershipClaimed &&
      this.state.subscriptionsReady
    );
  }

  markHttpStarted(): void {
    this.state.httpStarted = true;
    this.logger.log('[Bootstrap] HTTP server started');
  }

  markConnectorsRegistered(): void {
    this.state.connectorsRegistered = true;
    this.logger.log('[Bootstrap] Connectors registered');
  }

  markDetectorsLoaded(): void {
    this.state.detectorsLoaded = true;
    this.logger.log('[Bootstrap] Detectors loaded');
  }

  markOwnershipClaimed(): void {
    this.state.ownershipClaimed = true;
    this.logger.log('[Bootstrap] Ownership claimed');
  }

  markSubscriptionsReady(): void {
    this.state.subscriptionsReady = true;
    this.logger.log('[Bootstrap] Market subscriptions active');
  }

  markRuntimeReady(): void {
    this.state.runtimeReady = this.isReady();
    if (this.state.runtimeReady) {
      this.logger.log('[Bootstrap] Runtime ready');
    }
  }
}
