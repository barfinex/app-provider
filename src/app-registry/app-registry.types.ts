export type RegisteredAppType = 'advisor' | 'inspector' | 'detector';

export interface RegisteredAppEntity {
  appKey: string;
  appType: RegisteredAppType;
  baseUrl: string;
  displayName?: string;
  version?: string;
  ip?: string;
  meta?: Record<string, unknown>;
  status: 'registered' | 'unregistered';
  registeredAt: number;
  lastHeartbeatAt: number;
  updatedAt: number;
  unregisteredAt?: number | null;
}

export interface RegisterAppDto {
  appKey: string;
  appType: RegisteredAppType;
  baseUrl: string;
  displayName?: string;
  version?: string;
  ip?: string;
  meta?: Record<string, unknown>;
}

export interface UnregisterAppDto {
  appKey: string;
  appType: RegisteredAppType;
  reason?: string;
}

export interface HeartbeatAppDto {
  appKey: string;
  appType: RegisteredAppType;
  baseUrl?: string;
  ip?: string;
  meta?: Record<string, unknown>;
}
