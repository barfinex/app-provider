export type ProxyAppType = 'advisor' | 'inspector' | 'detector';

export interface ProxyTarget {
  key: string;
  type: ProxyAppType;
  baseUrl: string;
  enabled: boolean;
  source: 'db' | 'env' | 'config' | 'default';
}

export interface ProxyForwardResult {
  status: number;
  data: unknown;
  headers?: Record<string, string | string[] | undefined>;
}
