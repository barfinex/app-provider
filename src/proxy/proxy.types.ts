export type ProxyAppType = 'advisor' | 'inspector' | 'detector';

export type AppStatus = 'active' | 'offline' | 'unregistered';

export interface ProxyTarget {
  key: string;
  type: ProxyAppType;
  baseUrl: string;
  enabled: boolean;
  /** active = registered + recent heartbeat; offline = stale; unregistered = shut down */
  status: AppStatus;
  source: 'db' | 'env' | 'config' | 'default';
}

export interface ProxyForwardResult {
  status: number;
  data: unknown;
  headers?: Record<string, string | string[] | undefined>;
}
