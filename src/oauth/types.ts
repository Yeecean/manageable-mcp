import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';

export interface StoredOAuthTokens extends OAuthTokens {
  /**
   * Absolute expiry derived from `expires_in` when the token was saved. This is
   * deliberately not sent back to the SDK as a separate field; `tokens()`
   * converts it back to a remaining `expires_in`.
   */
  expiresAt?: number;
}

export interface OAuthStoreEntry {
  serverName: string;
  serverUrl: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: StoredOAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  updatedAt: number;
}

export interface OAuthStoreFile {
  version: 1;
  entries: Record<string, OAuthStoreEntry>;
}
