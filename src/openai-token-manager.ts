/**
 * EDUCATIONAL AND ENTERTAINMENT PURPOSES ONLY
 *
 * This software is provided for educational, research, and entertainment purposes only.
 * It is not affiliated with, endorsed by, or sponsored by Anthropic PBC or OpenAI.
 * Use at your own risk. No warranties provided. Users are solely responsible for
 * ensuring compliance with all applicable terms and laws.
 *
 * Copyright (c) 2025 - Licensed under MIT License
 */

/**
 * ChatGPT auth persistence helpers
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { exchangeIdTokenForOpenAIApiKey, refreshOpenAIAccessToken } from './openai-oauth.js';

type OpenAIRefreshTokenResponse = Awaited<ReturnType<typeof refreshOpenAIAccessToken>>;

export const CHATGPT_KEY_FILE = path.join(os.homedir(), '.chatgpt-api-key.json');
const OPENAI_TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export type OpenAIAuthSource = 'manual' | 'oauth';

export interface OpenAIAuthState {
  source: OpenAIAuthSource;
  apiKey: string;
  accountId?: string;
  planType?: string;
  createdAt: string;
  updatedAt?: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: number;
}

export interface OpenAIOAuthFileV1 {
  api_key: string;
  created_at: string;
}

interface OpenAIAuthFile {
  source: OpenAIAuthSource;
  api_key: string;
  account_id?: string;
  plan_type?: string;
  created_at: string;
  updated_at?: string;
  access_token?: string;
  refresh_token?: string;
  access_token_expires_at?: number;
}

function parseJwtClaims(token: string): Record<string, unknown> | null {
  const segments = token.split('.');
  if (segments.length < 2) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as {
      [key: string]: unknown;
    };
  } catch {
    return null;
  }
}

function getIdTokenAccountId(idToken: string): string | undefined {
  const claims = parseJwtClaims(idToken);
  if (!claims) {
    return undefined;
  }

  const authObject = claims['https://api.openai.com/auth'];
  if (typeof authObject === 'object' && authObject !== null) {
    const accountId = (authObject as { [key: string]: unknown }).chatgpt_account_id;
    return typeof accountId === 'string' && accountId.trim().length > 0 ? accountId.trim() : undefined;
  }

  return undefined;
}

/**
 * Legacy V1 file shape (manual API key only)
 */
function isLegacyState(payload: unknown): payload is OpenAIOAuthFileV1 {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const candidate = payload as { api_key?: unknown; created_at?: unknown };
  return typeof candidate.api_key === 'string' && typeof candidate.created_at === 'string';
}

export async function saveOpenAIAuthState(authState: OpenAIAuthState): Promise<void> {
  const payload: OpenAIAuthFile = {
    source: authState.source,
    api_key: authState.apiKey.trim(),
    created_at: authState.createdAt,
    updated_at: authState.updatedAt,
    account_id: authState.accountId?.trim(),
    plan_type: authState.planType?.trim(),
    access_token: authState.accessToken?.trim(),
    refresh_token: authState.refreshToken?.trim(),
    access_token_expires_at: authState.accessTokenExpiresAt,
  };

  await fs.writeFile(CHATGPT_KEY_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`✅ ChatGPT auth saved to ${CHATGPT_KEY_FILE}`);
}

export async function saveOpenAIKey(apiKey: string): Promise<void> {
  const key = apiKey.trim();
  await saveOpenAIAuthState({
    source: 'manual',
    apiKey: key,
    createdAt: new Date().toISOString(),
  });
}

export async function loadOpenAIAuthState(): Promise<OpenAIAuthState | null> {
  try {
    const content = await fs.readFile(CHATGPT_KEY_FILE, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    if (isLegacyState(parsed)) {
      return {
        source: 'manual',
        apiKey: parsed.api_key.trim(),
        createdAt: parsed.created_at,
      };
    }

    const payload = parsed as OpenAIAuthFile;
    if (typeof payload.api_key !== 'string' || !payload.api_key.trim()) {
      return null;
    }

    return {
      source: payload.source || 'manual',
      apiKey: payload.api_key.trim(),
      accountId: payload.account_id?.trim(),
      planType: payload.plan_type?.trim(),
      createdAt: payload.created_at,
      updatedAt: payload.updated_at?.trim(),
      accessToken: payload.access_token?.trim(),
      refreshToken: payload.refresh_token?.trim(),
      accessTokenExpiresAt:
        typeof payload.access_token_expires_at === 'number' ? payload.access_token_expires_at : undefined,
    };
  } catch {
    return null;
  }
}

function parseJwtExpiryMillis(token: string): number | null {
  const segments = token.split('.');
  if (segments.length < 2) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    const exp = typeof payload.exp === 'number' ? payload.exp : Number(payload.exp);
    if (!Number.isFinite(exp) || exp <= 0) {
      return null;
    }

    return exp * 1000;
  } catch {
    return null;
  }
}

function getStoredOpenAIAccessTokenExpirationMs(state: OpenAIAuthState): number | null {
  if (typeof state.accessTokenExpiresAt === 'number' && state.accessTokenExpiresAt > 0) {
    return state.accessTokenExpiresAt;
  }

  if (!state.accessToken) {
    return null;
  }

  return parseJwtExpiryMillis(state.accessToken);
}

function isOpenAIAccessTokenExpired(state: OpenAIAuthState): boolean {
  const expiresAtMs = getStoredOpenAIAccessTokenExpirationMs(state);
  if (!expiresAtMs) {
    return false;
  }

  return Date.now() >= expiresAtMs - OPENAI_TOKEN_EXPIRY_BUFFER_MS;
}

function normalizeRefreshResult(
  state: OpenAIAuthState,
  result: OpenAIRefreshTokenResponse,
  refreshedApiKey: string
): OpenAIAuthState {
  const oauthAccessToken = result.access_token;
  const refreshedAccountId = result.id_token ? getIdTokenAccountId(result.id_token) : undefined;
  const accessTokenExpiresAt =
    parseExpiringValue(result.expires_in, oauthAccessToken, undefined) || state.accessTokenExpiresAt;
  const refreshToken = result.refresh_token || state.refreshToken || '';
  return {
    source: 'oauth',
    apiKey: refreshedApiKey,
    createdAt: state.createdAt,
    updatedAt: new Date().toISOString(),
    planType: state.planType,
    accessToken: oauthAccessToken,
    accountId: refreshedAccountId || state.accountId,
    refreshToken,
    accessTokenExpiresAt,
  };
}

function parseExpiringValue(
  expiresIn: number | undefined,
  accessToken: string | undefined,
  fallback: number | undefined
): number | undefined {
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
    return Date.now() + expiresIn * 1000;
  }

  if (!accessToken) {
    return fallback;
  }

  return parseJwtExpiryMillis(accessToken) || fallback;
}

export async function getValidOpenAIAccessToken(): Promise<string> {
  const state = await loadOpenAIAuthState();
  if (!state || !state.apiKey) {
    throw new Error('No ChatGPT auth state found. Run ChatGPT OAuth (option 2) first.');
  }

  if (state.source === 'manual') {
    return state.apiKey;
  }

  if (!state.refreshToken) {
    if (!state.apiKey) {
      throw new Error('No OAuth API key and no refresh token are available. Re-authenticate.');
    }

    return state.apiKey;
  }

  if (!isOpenAIAccessTokenExpired(state) && state.apiKey) {
    return state.apiKey;
  }

  if (!state.refreshToken) {
    throw new Error('No access token stored for ChatGPT OAuth state.');
  }

  const refreshed = await refreshOpenAIAccessToken(state.refreshToken);
  if (!refreshed.id_token) {
    throw new Error(
      'ChatGPT token refresh did not return id_token. Re-authenticate to regenerate tokens.'
    );
  }

  const refreshedApiKey = await exchangeIdTokenForOpenAIApiKey(refreshed.id_token);
  if (!refreshedApiKey) {
    throw new Error('Failed to exchange refreshed ChatGPT token for OpenAI API key.');
  }

  const normalizedState = normalizeRefreshResult(state, refreshed, refreshedApiKey);
  await saveOpenAIAuthState(normalizedState);
  return normalizedState.apiKey;
}

export async function loadOpenAIKey(): Promise<string | null> {
  const state = await loadOpenAIAuthState();
  return state?.apiKey || null;
}

export function maskApiKey(apiKey: string): string {
  if (!apiKey) {
    return '';
  }

  if (apiKey.length <= 8) {
    return '*'.repeat(Math.min(apiKey.length, 4));
  }

  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}
