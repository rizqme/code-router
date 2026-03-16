/**
 * EDUCATIONAL AND ENTERTAINMENT PURPOSES ONLY
 *
 * This software is provided for educational, research, and entertainment purposes only.
 * It is not affiliated with, endorsed by, or sponsored by GitHub or Microsoft.
 * Use at your own risk. No warranties provided. Users are solely responsible for
 * ensuring compliance with GitHub's Terms of Service and all applicable laws.
 *
 * Copyright (c) 2025 - Licensed under MIT License
 */

/**
 * GitHub Copilot token persistence helpers
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export const COPILOT_TOKEN_FILE = path.join(os.homedir(), '.copilot-token.json');

export interface CopilotAuthState {
  accessToken: string;
  enterpriseUrl?: string;
  createdAt: string;
}

interface CopilotAuthFile {
  access_token: string;
  enterprise_url?: string;
  created_at: string;
}

/**
 * Save Copilot auth state to file
 */
export async function saveCopilotAuthState(state: CopilotAuthState): Promise<void> {
  const payload: CopilotAuthFile = {
    access_token: state.accessToken.trim(),
    enterprise_url: state.enterpriseUrl?.trim(),
    created_at: state.createdAt,
  };

  await fs.writeFile(COPILOT_TOKEN_FILE, JSON.stringify(payload, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  console.log(`✅ Copilot auth saved to ${COPILOT_TOKEN_FILE}`);
}

/**
 * Load Copilot auth state from file
 */
export async function loadCopilotAuthState(): Promise<CopilotAuthState | null> {
  try {
    const content = await fs.readFile(COPILOT_TOKEN_FILE, 'utf-8');
    const payload = JSON.parse(content) as CopilotAuthFile;

    if (typeof payload.access_token !== 'string' || !payload.access_token.trim()) {
      return null;
    }

    return {
      accessToken: payload.access_token.trim(),
      enterpriseUrl: payload.enterprise_url?.trim(),
      createdAt: payload.created_at,
    };
  } catch {
    return null;
  }
}

/**
 * Get a valid Copilot access token (GitHub tokens don't expire)
 */
export async function getValidCopilotAccessToken(): Promise<string> {
  const state = await loadCopilotAuthState();
  if (!state) {
    throw new Error('No Copilot auth found. Run Copilot OAuth (code-router auth copilot) first.');
  }
  return state.accessToken;
}

/**
 * Get the enterprise URL if configured
 */
export async function getCopilotEnterpriseUrl(): Promise<string | undefined> {
  const state = await loadCopilotAuthState();
  return state?.enterpriseUrl;
}

/**
 * Mask a token for display
 */
export function maskToken(token: string): string {
  if (!token) return '';
  if (token.length <= 8) return '*'.repeat(Math.min(token.length, 4));
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}
