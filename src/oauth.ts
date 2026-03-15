/**
 * EDUCATIONAL AND ENTERTAINMENT PURPOSES ONLY
 *
 * This software is provided for educational, research, and entertainment purposes only.
 * It is not affiliated with, endorsed by, or sponsored by Anthropic PBC.
 * Use at your own risk. No warranties provided. Users are solely responsible for
 * ensuring compliance with Anthropic's Terms of Service and all applicable laws.
 *
 * Copyright (c) 2025 - Licensed under MIT License
 */

/**
 * OAuth utilities for Anthropic MAX plan authentication
 */

import crypto from 'crypto';
import { exec } from 'child_process';
import { createServer } from 'http';
import { URL } from 'url';
import type { OAuthTokens, OAuthConfig } from './types.js';

export const OAUTH_CONFIG: OAuthConfig = {
  client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorize_url: 'https://claude.ai/oauth/authorize', // MAX mode
  token_url: 'https://console.anthropic.com/v1/oauth/token',
  redirect_uri: 'https://console.anthropic.com/oauth/code/callback',
  scope: 'org:create_api_key user:profile user:inference',
};

const LOCALHOST_CALLBACK_HOST = 'localhost';
const LOCALHOST_CALLBACK_PATH = '/callback';
const LOCALHOST_CALLBACK_TIMEOUT_MS = 120000;

let currentOAuthRedirectUri = OAUTH_CONFIG.redirect_uri;

/**
 * Generate PKCE code verifier and challenge
 */
export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  return { verifier, challenge };
}

/**
 * Generate random state for CSRF protection
 */
export function generateState(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Build authorization URL for OAuth flow
 */
export function getAuthorizationUrl(
  codeChallenge: string,
  state: string,
  redirectUri = OAUTH_CONFIG.redirect_uri
): string {
  const url = new URL(OAUTH_CONFIG.authorize_url);
  url.searchParams.set('code', 'true'); // Tell it to return code
  url.searchParams.set('client_id', OAUTH_CONFIG.client_id);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', OAUTH_CONFIG.scope);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);

  return url.toString();
}

function safeOpenUrl(url: string): boolean {
  const encodedUrl = `"${url}"`;
  const command =
    process.platform === 'darwin'
      ? `open ${encodedUrl}`
      : process.platform === 'win32'
        ? `start "" ${encodedUrl}`
        : `xdg-open ${encodedUrl}`;

  try {
    exec(command);
    return true;
  } catch {
    return false;
  }
}

function parseAuthorizationResponseInput(input: string): { code: string; state: string } {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new Error('Missing authorization response');
  }

  if (trimmed.includes('://')) {
    const parsed = new URL(trimmed);
    const error = parsed.searchParams.get('error');
    const errorDescription = parsed.searchParams.get('error_description');

    if (error) {
      throw new Error(`Authorization failed: ${errorDescription || error}`);
    }

    const code = parsed.searchParams.get('code');
    const returnedState = parsed.searchParams.get('state');
    if (!code || !returnedState) {
      throw new Error('Callback URL is missing code or state');
    }

    return { code, state: returnedState };
  }

  if (!trimmed.includes('#')) {
    throw new Error('Invalid format. Expected callback URL or code#state');
  }

  const [code, returnedState] = trimmed.split('#');
  if (!code || !returnedState) {
    throw new Error('Missing code or state');
  }

  return { code, state: returnedState };
}

async function startLocalCallbackServer(
  expectedState: string,
  timeoutMs: number
): Promise<{
  callbackUrl: string;
  waitForCode: Promise<{ code: string; state: string }>;
  close: () => void;
}> {
  return await new Promise((resolve, reject) => {
    let addressPort = 0;
    let resolved = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let resolvePromise!: (value: { code: string; state: string }) => void;
    let rejectPromise!: (reason: Error) => void;

    const waitForCode = new Promise<{ code: string; state: string }>((innerResolve, innerReject) => {
      resolvePromise = innerResolve;
      rejectPromise = innerReject;
    });

    const server = createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid request');
        return;
      }

      const callbackBaseUrl = `http://${LOCALHOST_CALLBACK_HOST}:${addressPort}/`;
      const parsed = new URL(req.url, callbackBaseUrl);
      if (parsed.pathname !== LOCALHOST_CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const code = parsed.searchParams.get('code');
      const returnedState = parsed.searchParams.get('state');
      const error = parsed.searchParams.get('error');
      const errorDescription = parsed.searchParams.get('error_description');

      if (error) {
        const message = `Authorization failed: ${errorDescription || error}`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body><h1>Claude Auth</h1><p>${message}</p></body></html>`);
        if (!resolved) {
          resolved = true;
          close();
          rejectPromise(new Error(message));
        }
        return;
      }

      if (!code || !returnedState) {
        const message = 'Missing code or state in callback';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body><h1>Claude Auth</h1><p>${message}</p></body></html>`);
        if (!resolved) {
          resolved = true;
          close();
          rejectPromise(new Error(message));
        }
        return;
      }

      if (returnedState !== expectedState) {
        const message = 'State mismatch - possible CSRF attack';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body><h1>Claude Auth</h1><p>${message}</p></body></html>`);
        if (!resolved) {
          resolved = true;
          close();
          rejectPromise(new Error(message));
        }
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<html><body><h1>Claude Auth</h1><p>Authentication complete. You can close this window.</p></body></html>'
      );

      if (!resolved) {
        resolved = true;
        close();
        resolvePromise({ code, state: returnedState });
      }
    });

    const close = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }

      server.close();
    };

    server.once('error', (error) => {
      if (!resolved) {
        resolved = true;
        close();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    server.listen(0, LOCALHOST_CALLBACK_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        resolved = true;
        close();
        reject(new Error('Failed to determine localhost callback port'));
        return;
      }

      addressPort = address.port;
      const callbackUrl = `http://${LOCALHOST_CALLBACK_HOST}:${addressPort}${LOCALHOST_CALLBACK_PATH}`;
      timeoutHandle = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          close();
          rejectPromise(new Error('Timed out waiting for localhost callback'));
        }
      }, timeoutMs);

      resolve({
        callbackUrl,
        waitForCode,
        close,
      });
    });
  });
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  state: string
): Promise<OAuthTokens> {
  // Anthropic uses JSON format (not standard OAuth form-urlencoded)
  const requestBody = {
    code,
    state,
    grant_type: 'authorization_code',
    client_id: OAUTH_CONFIG.client_id,
    redirect_uri: currentOAuthRedirectUri,
    code_verifier: codeVerifier,
  };

  const response = await fetch(OAUTH_CONFIG.token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  const tokens = (await response.json()) as OAuthTokens;

  // Add expiration timestamp
  tokens.expires_at = Date.now() + tokens.expires_in * 1000;
  tokens.created_at = new Date().toISOString();

  return tokens;
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
  // Anthropic uses JSON format
  const requestBody = {
    grant_type: 'refresh_token',
    client_id: OAUTH_CONFIG.client_id,
    refresh_token: refreshToken,
  };

  const response = await fetch(OAUTH_CONFIG.token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${error}`);
  }

  const tokens = (await response.json()) as OAuthTokens;

  // Add expiration timestamp
  tokens.expires_at = Date.now() + tokens.expires_in * 1000;
  tokens.created_at = new Date().toISOString();

  return tokens;
}

/**
 * Start OAuth flow - localhost callback first, manual fallback if needed
 */
export async function startOAuthFlow(
  askQuestion: (prompt: string) => Promise<string>
): Promise<{ code: string; verifier: string; state: string }> {
  const { verifier, challenge } = generatePKCE();
  const state = generateState();
  const callbackServer = await startLocalCallbackServer(state, LOCALHOST_CALLBACK_TIMEOUT_MS);
  currentOAuthRedirectUri = callbackServer.callbackUrl;
  const authUrl = getAuthorizationUrl(challenge, state, callbackServer.callbackUrl);

  console.log('\n🔐 Starting OAuth flow...\n');
  const opened = safeOpenUrl(authUrl);

  if (opened) {
    console.log('Opened the Anthropic authorization page in your browser.');
  } else {
    console.log('⚠️  Failed to auto-open browser.');
  }

  console.log('\nIf the browser did not open, use this URL:\n');
  console.log(authUrl);
  console.log(`\nWaiting for localhost callback on ${callbackServer.callbackUrl}...\n`);

  try {
    const callbackPayload = await callbackServer.waitForCode;
    console.log('\n✅ Authorization code received via localhost callback!\n');
    return { code: callbackPayload.code, verifier, state: callbackPayload.state };
  } catch (error) {
    console.log(
      `\n⚠️  Localhost callback did not complete automatically: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`
    );
    console.log('\n' + '='.repeat(70));
    console.log('Paste the full localhost callback URL from the browser, or use code#state.');
    console.log(
      `Example: ${callbackServer.callbackUrl}?code=...&state=...`
    );
    console.log('Fallback: abc123xyz...#def456uvw...');
    console.log('='.repeat(70) + '\n');
  }

  const input = await askQuestion('Paste callback URL or code#state here: ');
  const { code, state: returnedState } = parseAuthorizationResponseInput(input);

  if (returnedState !== state) {
    throw new Error('State mismatch - possible CSRF attack');
  }

  console.log('\n✅ Authorization code received!\n');
  return { code, verifier, state: returnedState };
}
