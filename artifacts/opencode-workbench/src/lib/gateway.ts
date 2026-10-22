/**
 * Gateway endpoint resolution (self-hosted companion gateway).
 *
 * When enabled, chat and model-catalog traffic goes to the user's
 * own companion gateway (agent/gateway.mjs) instead of OpenRouter
 * directly: the gateway URL is the companion URL, the credential is
 * the companion token, and the gateway routes each model id to the
 * right leg (local models, the OpenRouter key pool, configured
 * upstreams). When disabled or unconfigured, everything behaves
 * exactly as before — this module is the single switch point.
 */

const ENABLED_KEY = 'openforge-workbench-gateway-enabled';
const COMPANION_URL_KEY = 'openforge-companion-url';
const COMPANION_TOKEN_KEY = 'openforge-companion-token';

export function gatewayEnabled(): boolean {
  try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; }
}

export function setGatewayEnabled(on: boolean): void {
  try { localStorage.setItem(ENABLED_KEY, on ? '1' : '0'); } catch { /* best-effort */ }
}

export interface GatewayEndpoint { baseUrl: string; token: string }

/** The active gateway endpoint, or null when routing is direct. */
export function activeGateway(): GatewayEndpoint | null {
  if (!gatewayEnabled()) return null;
  try {
    const url = (localStorage.getItem(COMPANION_URL_KEY) || '').replace(/\/+$/, '');
    const token = localStorage.getItem(COMPANION_TOKEN_KEY) || '';
    if (!url || !token) return null;
    return { baseUrl: `${url}/v1`, token };
  } catch {
    return null;
  }
}
