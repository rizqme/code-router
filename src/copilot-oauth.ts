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
 * GitHub Copilot OAuth - Device Flow authentication
 */

import { exec } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const CLIENT_ID = 'Ov23li8tweQw6odWQebz';
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;
const DEVICE_FLOW_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

let packageVersion = '0.0.0';
try {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { version?: string };
  packageVersion = pkg.version || '0.0.0';
} catch {
  // ignore
}

function getUserAgent(): string {
  return `code-router/${packageVersion}`;
}

function normalizeDomain(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function getUrls(domain: string) {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
  };
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

export interface CopilotDeviceCodeResponse {
  verification_uri: string;
  user_code: string;
  device_code: string;
  interval: number;
}

export interface CopilotOAuthResult {
  accessToken: string;
  enterpriseUrl?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Request a device code from GitHub
 */
async function requestDeviceCode(domain: string): Promise<CopilotDeviceCodeResponse> {
  const { deviceCodeUrl } = getUrls(domain);

  const response = await fetch(deviceCodeUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': getUserAgent(),
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: 'read:user',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to initiate device authorization: ${text}`);
  }

  return (await response.json()) as CopilotDeviceCodeResponse;
}

/**
 * Poll for the access token after user authorizes
 */
async function pollForToken(
  domain: string,
  deviceCode: string,
  initialInterval: number
): Promise<string> {
  const { accessTokenUrl } = getUrls(domain);
  let interval = initialInterval;

  while (true) {
    const response = await fetch(accessTokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': getUserAgent(),
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: DEVICE_FLOW_GRANT_TYPE,
      }),
    });

    if (!response.ok) {
      throw new Error('Token polling request failed');
    }

    const data = (await response.json()) as {
      access_token?: string;
      error?: string;
      interval?: number;
    };

    if (data.access_token) {
      return data.access_token;
    }

    if (data.error === 'authorization_pending') {
      await sleep(interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS);
      continue;
    }

    if (data.error === 'slow_down') {
      // RFC 8628 §3.5: add 5 seconds to polling interval
      let newInterval = (interval + 5) * 1000;
      if (data.interval && typeof data.interval === 'number' && data.interval > 0) {
        newInterval = data.interval * 1000;
        interval = data.interval;
      } else {
        interval += 5;
      }
      await sleep(newInterval + OAUTH_POLLING_SAFETY_MARGIN_MS);
      continue;
    }

    if (data.error === 'expired_token') {
      throw new Error('Device code expired. Please try again.');
    }

    if (data.error === 'access_denied') {
      throw new Error('Authorization was denied by the user.');
    }

    if (data.error) {
      throw new Error(`Authorization failed: ${data.error}`);
    }

    await sleep(interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS);
  }
}

/**
 * Run the full GitHub Copilot Device Flow OAuth
 */
export async function runCopilotOAuthFlow(
  enterpriseUrl?: string
): Promise<CopilotOAuthResult> {
  const domain = enterpriseUrl ? normalizeDomain(enterpriseUrl) : 'github.com';

  console.log('\n🔐 Starting GitHub Copilot OAuth flow...\n');

  const deviceData = await requestDeviceCode(domain);

  console.log('Open this URL in your browser:\n');
  console.log(`  ${deviceData.verification_uri}\n`);
  console.log(`Enter this code: ${deviceData.user_code}\n`);

  const opened = safeOpenUrl(deviceData.verification_uri);
  if (opened) {
    console.log('Browser opened automatically.');
  } else {
    console.log('⚠️  Could not open browser automatically. Open the URL above manually.');
  }

  console.log('\nWaiting for authorization...\n');

  const accessToken = await pollForToken(domain, deviceData.device_code, deviceData.interval);

  console.log('✅ GitHub Copilot authorization successful!\n');

  const result: CopilotOAuthResult = { accessToken };
  if (enterpriseUrl) {
    result.enterpriseUrl = domain;
  }

  return result;
}

/**
 * Get the Copilot API base URL for a given enterprise domain
 */
export function getCopilotApiBaseUrl(enterpriseUrl?: string): string {
  if (enterpriseUrl) {
    return `https://copilot-api.${normalizeDomain(enterpriseUrl)}`;
  }
  return 'https://api.githubcopilot.com';
}
