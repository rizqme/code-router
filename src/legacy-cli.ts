#!/usr/bin/env tsx

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
 * Interactive CLI for Anthropic MAX Plan OAuth
 */

import readline from 'readline';
import { startOAuthFlow, exchangeCodeForTokens } from './oauth.js';
import {
  loadTokens,
  saveTokens,
  isTokenExpired,
  getValidAccessToken,
  TOKEN_FILE,
} from './token-manager.js';
import { runOpenAIOAuthFlow } from './openai-oauth.js';
import {
  CHATGPT_KEY_FILE,
  loadOpenAIAuthState,
  saveOpenAIAuthState,
  saveOpenAIKey,
  maskApiKey,
  getValidOpenAIAccessToken,
} from './openai-token-manager.js';
import type { OAuthTokens } from './types.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

const OPENAI_MODELS_URL =
  'https://chatgpt.com/backend-api/codex/models?client_version=0.114.0';
const OPENAI_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA =
  'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';

function printSection(title: string) {
  console.log('\n' + '='.repeat(70));
  console.log(title);
  console.log('='.repeat(70));
}

function extractTextFromAnthropicResponse(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return '';
  }

  const textBlock = content.find(
    (entry) =>
      !!entry &&
      typeof entry === 'object' &&
      (entry as { type?: unknown }).type === 'text' &&
      typeof (entry as { text?: unknown }).text === 'string'
  ) as { text?: string } | undefined;

  return textBlock?.text?.trim() || '';
}

async function buildOpenAIBackendHeaders(): Promise<Record<string, string>> {
  const apiKey = await getValidOpenAIAccessToken();
  const authState = await loadOpenAIAuthState();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    accept: 'text/event-stream',
    'Content-Type': 'application/json',
    originator: 'Code Router CLI',
    session_id: Math.random().toString(36).slice(2),
  };

  if (authState?.accountId) {
    headers['ChatGPT-Account-ID'] = authState.accountId;
  }

  return headers;
}

async function readChatGPTSSEText(response: Response): Promise<string> {
  if (!response.body) {
    return '';
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';

  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const separatorIndex = buffer.indexOf('\n\n');
      if (separatorIndex === -1) {
        break;
      }

      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const dataLines = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());

      if (dataLines.length === 0) {
        continue;
      }

      try {
        const payload = JSON.parse(dataLines.join('\n')) as { type?: unknown; delta?: unknown };
        if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
          output += payload.delta;
        }
      } catch {
        continue;
      }
    }
  }

  return output.trim();
}

async function fetchAnthropicModels() {
  const accessToken = await getValidAccessToken();
  const response = await fetch(ANTHROPIC_MODELS_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ANTHROPIC_BETA,
    },
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(payload));
  }

  return payload as { data?: Array<{ id?: string; display_name?: string }> };
}

async function fetchOpenAIModels() {
  const headers = await buildOpenAIBackendHeaders();
  delete headers['Content-Type'];

  const response = await fetch(OPENAI_MODELS_URL, {
    method: 'GET',
    headers,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(payload));
  }

  return payload as { models?: Array<{ slug?: string; display_name?: string }> };
}

async function verifyAnthropicSubscription() {
  const accessToken = await getValidAccessToken();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ANTHROPIC_BETA,
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(payload));
  }

  return {
    model: (payload as { model?: string }).model || 'unknown',
    text: extractTextFromAnthropicResponse(payload),
  };
}

async function verifyOpenAISubscription() {
  const headers = await buildOpenAIBackendHeaders();
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'gpt-5.4',
      instructions: 'You are a helpful assistant.',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Reply with exactly: ok' }],
        },
      ],
      parallel_tool_calls: true,
      reasoning: { effort: 'medium' },
      store: false,
      stream: true,
      text: { verbosity: 'low' },
      tool_choice: 'auto',
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return {
    model: 'gpt-5.4',
    text: await readChatGPTSSEText(response),
  };
}

async function showAuthStatus() {
  printSection('AUTHENTICATION STATUS');

  const tokens = await loadTokens();
  const envOpenAIKey = process.env.CODE_ROUTER_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const chatGPTAuthState = await loadOpenAIAuthState();
  const savedOpenAIKey = chatGPTAuthState?.apiKey ?? null;
  const chatGPTConfigured = Boolean(envOpenAIKey) || Boolean(savedOpenAIKey);
  const chatGPTSource = envOpenAIKey
    ? 'environment'
    : chatGPTAuthState
      ? `${chatGPTAuthState.source} auth file`
      : null;
  const chatGPTExtra =
    chatGPTAuthState?.source === 'oauth' && chatGPTAuthState.accountId
      ? `account_id=${chatGPTAuthState.accountId}`
      : '';

  if (!tokens) {
    console.log('❌ Claude MAX not configured\n');
  } else {
    const expired = isTokenExpired(tokens);
    const expiresIn = tokens.expires_at
      ? Math.floor((tokens.expires_at - Date.now()) / 1000 / 60)
      : 0;

    console.log('✅ Authenticated');
    console.log(`   Scope: ${tokens.scope}`);
    console.log(`   Status: ${expired ? '⚠️  EXPIRED' : '✓ Valid'}`);
    if (!expired && expiresIn > 0) {
      console.log(`   Expires in: ${expiresIn} minutes`);
    }
    console.log('');
  }

  if (chatGPTConfigured) {
    const displayedKey = envOpenAIKey || savedOpenAIKey;
    console.log('✅ ChatGPT configured');
    console.log(`   Source: ${chatGPTSource}`);
    console.log(`   Access token: ${maskApiKey(displayedKey as string)}`);
    if (chatGPTExtra) {
      console.log(`   ${chatGPTExtra}`);
    }
    if (chatGPTAuthState?.refreshToken) {
      console.log(`   Refresh token: ${maskApiKey(chatGPTAuthState.refreshToken)}`);
    }
    console.log('');
  } else {
    console.log('❌ ChatGPT not configured\n');
  }

  return tokens;
}

async function handleSetOpenAIKey() {
  printSection('MANUAL CHATGPT TOKEN');

  const key = await question('\nPaste your ChatGPT ready-to-use token/API key: ');
  const trimmed = key.trim();

  if (!trimmed) {
    console.log('\n❌ Token is required.\n');
    return;
  }

  try {
    const oauthAccessToken = (await question('Paste ChatGPT OAuth access token (optional): ')).trim();
    const refreshToken = (await question('Paste ChatGPT refresh token (optional): ')).trim();
    const accountId = (await question('Paste ChatGPT account id (optional): ')).trim();

    if (oauthAccessToken || refreshToken || accountId) {
      await saveOpenAIAuthState({
        source: 'oauth',
        apiKey: trimmed,
        accessToken: oauthAccessToken || undefined,
        refreshToken: refreshToken || undefined,
        accountId: accountId || undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } else {
      await saveOpenAIKey(trimmed);
    }

    console.log('\n✅ ChatGPT token saved for router use.\n');
    console.log('Restart router to pick up updated key in runtime.\n');
  } catch (error) {
    console.error('\n❌ Failed to save key:', error instanceof Error ? error.message : error);
    console.log('');
  }
}

async function handleAuthenticateChatGPTOAuth() {
  printSection('CHATGPT OAUTH');

  try {
    const result = await runOpenAIOAuthFlow(question);
    await saveOpenAIAuthState({
      source: 'oauth',
      apiKey: result.accessToken,
      accessToken: result.oauthAccessToken,
      accountId: result.accountId,
      refreshToken: result.refreshToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt,
      createdAt: new Date().toISOString(),
    });
    console.log('\n✅ ChatGPT OAuth authentication saved for router use.\n');
    console.log('Ready to use API key:');
    console.log(result.accessToken);
    console.log('\nOAuth access token:');
    console.log(result.oauthAccessToken);
    console.log('\nReady to use refresh token:');
    console.log(result.refreshToken || '(none)');
    console.log('\nIf your browser already signed you in, the router now has ChatGPT subscription access.');
    console.log('Restart router to load updated auth if it is already running.\n');
  } catch (error) {
    console.error('\n❌ ChatGPT OAuth flow failed:', error instanceof Error ? error.message : error);
    console.log('   You can still use option 3 to set a ChatGPT API key manually.\n');
  }
}

async function handleAuthenticate() {
  printSection('CLAUDE MAX OAUTH');
  console.log('\nStarting OAuth flow...');
  console.log('Your browser will open to authorize this application.\n');

  try {
    const { code, verifier, state } = await startOAuthFlow(question);
    console.log('\n✅ Authorization received');
    console.log('🔄 Exchanging for tokens...\n');

    const tokens = await exchangeCodeForTokens(code, verifier, state);
    await saveTokens(tokens);

    console.log('✅ Tokens saved to .oauth-tokens.json');
    console.log('✅ Authentication successful!\n');
    console.log('Token details:');
    console.log(`  Scope: ${tokens.scope}`);
    console.log(`  Expires in: ${Math.floor(tokens.expires_in / 3600)} hours`);
    console.log('');
  } catch (error) {
    console.error('\n❌ Authentication failed:', error instanceof Error ? error.message : error);
    console.log('');
  }
}

async function handleListModels() {
  printSection('LIST MODELS');

  try {
    const [anthropicModels, openaiModels] = await Promise.allSettled([
      fetchAnthropicModels(),
      fetchOpenAIModels(),
    ]);

    console.log('\nClaude models:');
    if (anthropicModels.status === 'fulfilled') {
      for (const model of anthropicModels.value.data || []) {
        console.log(`  - ${model.id}${model.display_name ? ` (${model.display_name})` : ''}`);
      }
    } else {
      console.log(`  ❌ ${anthropicModels.reason instanceof Error ? anthropicModels.reason.message : anthropicModels.reason}`);
    }

    console.log('\nChatGPT models:');
    if (openaiModels.status === 'fulfilled') {
      for (const model of openaiModels.value.models || []) {
        console.log(`  - ${model.slug}${model.display_name ? ` (${model.display_name})` : ''}`);
      }
    } else {
      console.log(`  ❌ ${openaiModels.reason instanceof Error ? openaiModels.reason.message : openaiModels.reason}`);
    }
    console.log('');
  } catch (error) {
    console.error('\n❌ Error:', error instanceof Error ? error.message : error);
    console.log('');
  }
}

async function handleVerifySubscriptions() {
  printSection('VERIFY SUBSCRIPTIONS');

  const [anthropicResult, openaiResult] = await Promise.allSettled([
    verifyAnthropicSubscription(),
    verifyOpenAISubscription(),
  ]);

  if (anthropicResult.status === 'fulfilled') {
    console.log(`✅ Claude MAX: ${anthropicResult.value.model} -> ${anthropicResult.value.text || '(empty response)'}`);
  } else {
    console.log(
      `❌ Claude MAX: ${anthropicResult.reason instanceof Error ? anthropicResult.reason.message : anthropicResult.reason}`
    );
  }

  if (openaiResult.status === 'fulfilled') {
    console.log(`✅ ChatGPT: ${openaiResult.value.model} -> ${openaiResult.value.text || '(empty response)'}`);
  } else {
    console.log(
      `❌ ChatGPT: ${openaiResult.reason instanceof Error ? openaiResult.reason.message : openaiResult.reason}`
    );
  }

  console.log('');
}

async function handleManualClaudeTokens() {
  printSection('MANUAL CLAUDE TOKENS');

  const accessToken = (await question('\nPaste Claude access token: ')).trim();
  const refreshToken = (await question('Paste Claude refresh token: ')).trim();
  const scope = (await question('Scope [org:create_api_key user:profile user:inference]: ')).trim();
  const hoursInput = (await question('Hours until expiry [8]: ')).trim();

  if (!accessToken || !refreshToken) {
    console.log('\n❌ Access token and refresh token are required.\n');
    return;
  }

  const hours = Number(hoursInput || '8');
  const expiresIn = Number.isFinite(hours) && hours > 0 ? Math.floor(hours * 3600) : 8 * 3600;
  const tokens: OAuthTokens = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    token_type: 'Bearer',
    scope: scope || 'org:create_api_key user:profile user:inference',
    expires_at: Date.now() + expiresIn * 1000,
    created_at: new Date().toISOString(),
  };

  await saveTokens(tokens);
  console.log('\n✅ Claude tokens saved.\n');
}

async function handleAuthenticateMenu() {
  printSection('AUTH');
  console.log('\nOptions:');
  console.log('  1. Claude MAX OAuth');
  console.log('  2. ChatGPT OAuth');
  console.log('  3. Back\n');

  switch ((await question('Select option (1-3): ')).trim()) {
    case '1':
      await handleAuthenticate();
      return;
    case '2':
      await handleAuthenticateChatGPTOAuth();
      return;
    default:
      return;
  }
}

async function handleManualTokenMenu() {
  printSection('MANUAL TOKENS');
  console.log('\nOptions:');
  console.log('  1. Claude tokens');
  console.log('  2. ChatGPT tokens');
  console.log('  3. Back\n');

  switch ((await question('Select option (1-3): ')).trim()) {
    case '1':
      await handleManualClaudeTokens();
      return;
    case '2':
      await handleSetOpenAIKey();
      return;
    default:
      return;
  }
}

async function deleteIfExists(path: string) {
  try {
    const fs = await import('fs/promises');
    await fs.unlink(path);
  } catch {
    return;
  }
}

async function handleLogout() {
  printSection('LOGOUT');
  console.log('\nOptions:');
  console.log('  1. Claude');
  console.log('  2. ChatGPT');
  console.log('  3. Both');
  console.log('  4. Back\n');

  const choice = (await question('Select option (1-4): ')).trim();
  if (choice === '4') {
    return;
  }

  const confirm = await question('Delete stored credentials? (y/N): ');
  if (confirm.toLowerCase() !== 'y') {
    console.log('\n❌ Logout cancelled.\n');
    return;
  }

  if (choice === '1' || choice === '3') {
    await deleteIfExists(TOKEN_FILE);
  }

  if (choice === '2' || choice === '3') {
    await deleteIfExists(CHATGPT_KEY_FILE);
  }

  console.log('\n✅ Stored credentials removed.\n');
}

async function showMenu(): Promise<string> {
  console.log('='.repeat(70));
  console.log('CODE ROUTER');
  console.log('='.repeat(70));
  console.log('\nOptions:');
  console.log('  1. Auth');
  console.log('  2. List models');
  console.log('  3. Verify subscriptions');
  console.log('  4. Manually copy token');
  console.log('  5. Logout');
  console.log('  6. Exit\n');

  return await question('Select option (1-6): ');
}

async function main() {
  // ASCII Banner
  console.log('\n');
  console.log('██████╗ ██████╗ ██████╗ ███████╗');
  console.log('██╔════╝██╔═══██╗██╔══██╗██╔════╝');
  console.log('██║     ██║   ██║██║  ██║█████╗  ');
  console.log('██║     ██║   ██║██║  ██║██╔══╝  ');
  console.log('╚██████╗╚██████╔╝██████╔╝███████╗');
  console.log(' ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝');
  console.log('');
  console.log('██████╗  ██████╗ ██╗   ██╗████████╗███████╗██████╗ ');
  console.log('██╔══██╗██╔═══██╗██║   ██║╚══██╔══╝██╔════╝██╔══██╗');
  console.log('██████╔╝██║   ██║██║   ██║   ██║   █████╗  ██████╔╝');
  console.log('██╔══██╗██║   ██║██║   ██║   ██║   ██╔══╝  ██╔══██╗');
  console.log('██║  ██║╚██████╔╝╚██████╔╝   ██║   ███████╗██║  ██║');
  console.log('╚═╝  ╚═╝ ╚═════╝  ╚═════╝    ╚═╝   ╚══════╝╚═╝  ╚═╝');
  console.log('');

  while (true) {
    await showAuthStatus();

    const choice = await showMenu();

    switch (choice.trim()) {
      case '1':
        await handleAuthenticateMenu();
        break;

      case '2':
        await handleListModels();
        break;

      case '3':
        await handleVerifySubscriptions();
        break;

      case '4':
        await handleManualTokenMenu();
        break;

      case '5':
        await handleLogout();
        break;

      case '6':
        console.log('\n👋 Goodbye!\n');
        rl.close();
        process.exit(0);

      default:
        console.log('\n❌ Invalid option. Please select 1-6.\n');
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  rl.close();
  process.exit(1);
});
