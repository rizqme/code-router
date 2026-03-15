/**
 * EDUCATIONAL AND ENTERTAINMENT PURPOSES ONLY
 *
 * This software is provided for educational, research, and entertainment purposes only.
 * It is not affiliated with, endorsed by, or sponsored by Anthropic PBC or OpenAI.
 * Use at your own risk. No warranties provided. Users are solely responsible for
 * ensuring compliance with applicable Terms of Service and all applicable laws.
 *
 * Copyright (c) 2025 - Licensed under MIT License
 */

import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { createServer } from 'node:http';
import { URL } from 'url';

const OPENAI_AUTH_ISSUER = 'https://auth.openai.com';
const OPENAI_OAUTH_AUTH_PATH = '/oauth/authorize';
const OPENAI_OAUTH_TOKEN_PATH = '/oauth/token';
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_OAUTH_SCOPE =
  'openid profile email offline_access api.connectors.read api.connectors.invoke';
const OPENAI_TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const OPENAI_TOKEN_EXCHANGE_SUBJECT_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
const OPENAI_ORIGINATOR = 'code-router-cli';
const OPENAI_CALLBACK_HOST = 'localhost';
const OPENAI_CALLBACK_PORT = 1455;
const OPENAI_CALLBACK_PATH = '/auth/callback';
const OPENAI_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const OPENAI_REDIRECT_URI = `http://${OPENAI_CALLBACK_HOST}:${OPENAI_CALLBACK_PORT}${OPENAI_CALLBACK_PATH}`;

type AskQuestion = (prompt: string) => Promise<string>;

interface OpenAIClientTokens {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface OpenAIOAuthResult {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  oauthAccessToken: string;
  accessTokenExpiresAt?: number;
  accountId: string;
  apiKeyExchangeSucceeded: boolean;
}

interface CallbackContext {
  code: string;
}

interface JWTClaims {
  [key: string]: unknown;
}

interface FormBody {
  [key: string]: string;
}

function generateState(): string {
  return crypto.randomBytes(32).toString('hex');
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  return { verifier, challenge };
}

function buildAuthorizationUrl(codeChallenge: string, state: string): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: OPENAI_CLIENT_ID,
    redirect_uri: OPENAI_REDIRECT_URI,
    scope: OPENAI_OAUTH_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    originator: OPENAI_ORIGINATOR,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
  });

  return `${OPENAI_AUTH_ISSUER}${OPENAI_OAUTH_AUTH_PATH}?${query.toString()}`;
}

function toFormBodyString(values: FormBody): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    params.append(key, value);
  }
  return params.toString();
}

function parseExpiringValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function parseResponseBody(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text || '{}') as Record<string, unknown>;
  } catch {
    return { message: text };
  }
}

function extractJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) {
    return null;
  }

  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as JWTClaims;
    return claims;
  } catch {
    return null;
  }
}

function getIdTokenOrganizationId(idToken: string): string | undefined {
  const claims = extractJwtClaims(idToken);
  if (!claims) {
    return undefined;
  }

  const authObject = claims['https://api.openai.com/auth'];
  if (typeof authObject === 'object' && authObject !== null) {
    const organizationId = (authObject as JWTClaims).organization_id;
    return typeof organizationId === 'string' && organizationId.trim().length > 0
      ? organizationId.trim()
      : undefined;
  }

  return undefined;
}

function getIdTokenAccountId(idToken: string): string | undefined {
  const claims = extractJwtClaims(idToken);
  if (!claims) {
    return undefined;
  }

  const authObject = claims['https://api.openai.com/auth'];
  if (typeof authObject === 'object' && authObject !== null) {
    const accountId = (authObject as JWTClaims).chatgpt_account_id;
    return typeof accountId === 'string' && accountId.trim().length > 0 ? accountId.trim() : undefined;
  }

  return undefined;
}

async function requestTokenExchange(form: FormBody): Promise<Record<string, unknown>> {
  const response = await fetch(`${OPENAI_AUTH_ISSUER}${OPENAI_OAUTH_TOKEN_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: toFormBodyString(form),
  });

  const responseText = await response.text();
  const body = parseResponseBody(responseText);

  if (!response.ok) {
    const errorText =
      typeof body.error_description === 'string'
        ? body.error_description
        : typeof body.error === 'string'
          ? body.error
          : typeof body.message === 'string'
            ? body.message
            : responseText || response.statusText || 'token exchange failed';
    throw new Error(`token endpoint returned ${response.status}: ${errorText}`);
  }

  return body;
}

function normalizeTokenResponse(
  raw: Record<string, unknown>,
  requireIdToken: boolean
): OpenAIClientTokens {
  if (typeof raw.access_token !== 'string' || !raw.access_token.trim()) {
    throw new Error('Authorization code exchange did not return access_token');
  }

  if (requireIdToken && (typeof raw.id_token !== 'string' || !raw.id_token.trim())) {
    throw new Error('Authorization code exchange did not return id_token');
  }

  return {
    id_token: typeof raw.id_token === 'string' ? raw.id_token : undefined,
    access_token: String(raw.access_token || ''),
    refresh_token: typeof raw.refresh_token === 'string' ? raw.refresh_token : undefined,
    expires_in: parseExpiringValue(raw.expires_in),
  };
}

export async function exchangeIdTokenForOpenAIApiKey(idToken: string): Promise<string> {
  const raw = await requestTokenExchange({
    grant_type: OPENAI_TOKEN_EXCHANGE_GRANT_TYPE,
    client_id: OPENAI_CLIENT_ID,
    requested_token: 'openai-api-key',
    subject_token: idToken,
    subject_token_type: OPENAI_TOKEN_EXCHANGE_SUBJECT_TYPE,
  });

  if (typeof raw.access_token !== 'string' || !raw.access_token.trim()) {
    throw new Error('OpenAI API key token exchange did not return access_token');
  }

  return raw.access_token;
}

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string
): Promise<OpenAIClientTokens> {
  const raw = await requestTokenExchange({
    grant_type: 'authorization_code',
    client_id: OPENAI_CLIENT_ID,
    code,
    redirect_uri: OPENAI_REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  return normalizeTokenResponse(raw, true);
}

export async function refreshOpenAIAccessToken(
  refreshToken: string
): Promise<OpenAIClientTokens> {
  const raw = await requestTokenExchange({
    grant_type: 'refresh_token',
    client_id: OPENAI_CLIENT_ID,
    refresh_token: refreshToken,
  });

  return normalizeTokenResponse(raw, false);
}

async function exchangeCodeForTokensWithRefresh(
  code: string,
  codeVerifier: string
): Promise<OpenAIClientTokens> {
  const raw = await exchangeCodeForTokens(code, codeVerifier);
  if (typeof raw.refresh_token !== 'string' || !raw.refresh_token.trim()) {
    throw new Error('Authorization code exchange did not return refresh_token');
  }
  return raw;
}

function safeOpenUrl(url: string): void {
  const encodedUrl = `"${url}"`;
  const command =
    process.platform === 'darwin'
      ? `open ${encodedUrl}`
      : process.platform === 'win32'
        ? `start "" ${encodedUrl}`
        : `xdg-open ${encodedUrl}`;

  try {
    exec(command);
  } catch {
    console.log('⚠️  Failed to auto-open browser. Open the URL manually.');
  }
}

function startCallbackServer(
  state: string,
  timeoutMs: number,
  callbackPath: string
): { waitForCode: Promise<CallbackContext>; close: () => void } {
  const callbackUrl = `http://${OPENAI_CALLBACK_HOST}:${OPENAI_CALLBACK_PORT}${callbackPath}`;
  let resolvePromise: (value: CallbackContext) => void;
  let rejectPromise: (reason: Error) => void;
  let resolved = false;
  let timeoutHandle: NodeJS.Timeout | null = null;
  let server: ReturnType<typeof createServer> | null = null;

  const waitForCode = new Promise<CallbackContext>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;

    const localServer = createServer((req, res) => {
      if (req.url == null) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid request');
        return;
      }

      const parsed = new URL(req.url, callbackUrl);
      if (parsed.pathname !== callbackPath) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const code = parsed.searchParams.get('code');
      const returnedState = parsed.searchParams.get('state');
      const error = parsed.searchParams.get('error');
      const errorDescription = parsed.searchParams.get('error_description');

      if (error) {
        const message = `Authorization error: ${errorDescription || error}`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body><h1>ChatGPT OAuth</h1><p>${message}</p></body></html>`);
        if (!resolved) {
          resolved = true;
          rejectPromise(new Error(message));
        }
        return;
      }

      if (!code || !returnedState) {
        const message = 'Missing code or state in callback';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body><h1>ChatGPT OAuth</h1><p>${message}</p></body></html>`);
        if (!resolved) {
          resolved = true;
          rejectPromise(new Error(message));
        }
        return;
      }

      if (returnedState !== state) {
        const message = 'State mismatch in callback';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body><h1>ChatGPT OAuth</h1><p>${message}</p></body></html>`);
        if (!resolved) {
          resolved = true;
          rejectPromise(new Error(message));
        }
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>ChatGPT auth complete</h1><p>You can close this tab.</p></body></html>');
      if (!resolved) {
        resolved = true;
        resolvePromise({ code });
      }
    });

    localServer.on('error', (error: NodeJS.ErrnoException) => {
      if (!resolved) {
        resolved = true;
        const message =
          error.code === 'EADDRINUSE'
            ? `Port ${OPENAI_CALLBACK_PORT} is already in use. Close any other OAuth flows and try again.`
            : `Callback server error: ${String(error.message)}`;
        rejectPromise(new Error(message));
      }
    });

    localServer.listen(OPENAI_CALLBACK_PORT, OPENAI_CALLBACK_HOST, () => {
      console.log(`Listening for OpenAI OAuth callback on ${callbackUrl}`);
    });

    timeoutHandle = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        rejectPromise(new Error('Callback timeout.'));
      }
    }, timeoutMs);

    server = localServer;
  });

  const close = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }

    if (server && server.listening) {
      server.close();
    }
  };

  return { waitForCode, close };
}

/**
 * Run OpenAI OAuth with a Codex/Craft-style flow.
 * Stores and returns id/access/refresh tokens from OpenAI OAuth.
 */
export async function runOpenAIOAuthFlow(
  _askQuestion: AskQuestion
): Promise<OpenAIOAuthResult> {
  const { verifier, challenge } = generatePKCE();
  const state = generateState();
  const authUrl = buildAuthorizationUrl(challenge, state);
  const { waitForCode, close } = startCallbackServer(state, OPENAI_CALLBACK_TIMEOUT_MS, OPENAI_CALLBACK_PATH);

  try {
    console.log('\n🔐 Starting ChatGPT OAuth flow...\n');
    console.log(`Open this URL in your browser:\n\n${authUrl}\n`);
    safeOpenUrl(authUrl);
    console.log(`\nWaiting for callback on ${OPENAI_REDIRECT_URI}...\n`);

    const callbackPayload = await waitForCode;
    const exchanged = await exchangeCodeForTokensWithRefresh(callbackPayload.code, verifier);
    const idToken = exchanged.id_token;
    if (!idToken) {
      throw new Error('Authorization code exchange did not return id_token');
    }

    const accountId = getIdTokenAccountId(idToken);
    if (!accountId) {
      throw new Error(
        'Authorization code exchange id_token is missing required chatgpt_account_id claim'
      );
    }

    const organizationId = getIdTokenOrganizationId(idToken);
    let openAIAccessToken = exchanged.access_token;
    let apiKeyExchangeSucceeded = false;
    if (organizationId) {
      console.log(`Using organization_id: ${organizationId}`);
      try {
        openAIAccessToken = await exchangeIdTokenForOpenAIApiKey(idToken);
        apiKeyExchangeSucceeded = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`API-key exchange unavailable; using backend OAuth token instead (${message})`);
      }
    } else {
      console.log('organization_id claim missing; using backend OAuth token instead');
    }

    const refreshToken = exchanged.refresh_token;
    if (!refreshToken) {
      throw new Error('Authorization code exchange did not return refresh_token');
    }
    const idTokenExpiry = exchanged.expires_in
      ? Date.now() + exchanged.expires_in * 1000
      : undefined;
    return {
      idToken,
      accessToken: openAIAccessToken,
      oauthAccessToken: exchanged.access_token,
      refreshToken,
      accountId,
      accessTokenExpiresAt: idTokenExpiry,
      apiKeyExchangeSucceeded,
    };
  } finally {
    close();
  }
}
