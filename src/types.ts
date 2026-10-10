export type Environment = 'production' | 'sandbox';
export type Credentials = {
  environment?: Environment;
  accountId: string;
} & ({ type: 'api_key'; apiKey: string } | { type: 'oauth2'; accessToken: string });
export interface Account { id: string; name?: string }
export interface Resource extends Record<string, unknown> { id: string }
export interface Runtime {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
  maxPages?: number;
  maxDownloadBytes?: number;
  /** Trusted deployment setting, never a customer-controlled input. */
  trustedDownloadOrigins?: readonly string[];
}
