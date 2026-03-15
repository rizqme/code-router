#!/usr/bin/env tsx

import { execSync, spawn } from 'child_process';
import { readFileSync } from 'fs';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
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

const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version?: string };
const VERSION = PACKAGE_VERSION.version || '0.0.0';

type AuthSnapshot = {
  routerRunning: boolean;
  claudeConfigured: boolean;
  claudeExpired: boolean;
  claudeScope: string | null;
  claudeExpiresInMinutes: number | null;
  chatgptConfigured: boolean;
  chatgptSource: string | null;
  chatgptMaskedToken: string | null;
  chatgptMaskedRefresh: string | null;
  chatgptAccountId: string | null;
};

type MenuKey =
  | 'serve'
  | 'start-serve'
  | 'stop-serve'
  | 'show-apis'
  | 'select-api-openai'
  | 'select-api-claude'
  | 'select-api-openrouter'
  | 'auth'
  | 'list-models'
  | 'verify'
  | 'manual-token'
  | 'logout'
  | 'exit'
  | 'back'
  | 'claude-oauth'
  | 'chatgpt-oauth'
  | 'manual-claude'
  | 'manual-chatgpt'
  | 'logout-claude'
  | 'logout-chatgpt'
  | 'logout-both';

type MenuItem = {
  key: MenuKey;
  label: string;
};

type PromptRequest = {
  label: string;
  value: string;
  resolve: (value: string) => void;
};

const OPENAI_MODELS_URL =
  'https://chatgpt.com/backend-api/codex/models?client_version=0.114.0';
const OPENAI_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA =
  'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';

const ROOT_MENU: MenuItem[] = [
  { key: 'serve', label: 'Serve' },
  { key: 'auth', label: 'Auth' },
  { key: 'list-models', label: 'List models' },
  { key: 'verify', label: 'Verify subscriptions' },
  { key: 'manual-token', label: 'Manually copy token' },
  { key: 'logout', label: 'Logout' },
  { key: 'exit', label: 'Exit' },
];

const SERVE_MENU: MenuItem[] = [
  { key: 'start-serve', label: 'Start' },
  { key: 'stop-serve', label: 'Stop' },
  { key: 'show-apis', label: 'Show APIs' },
  { key: 'back', label: 'Back' },
];

const AUTH_MENU: MenuItem[] = [
  { key: 'claude-oauth', label: 'Claude MAX OAuth' },
  { key: 'chatgpt-oauth', label: 'ChatGPT OAuth' },
  { key: 'back', label: 'Back' },
];

const MANUAL_TOKEN_MENU: MenuItem[] = [
  { key: 'manual-claude', label: 'Claude tokens' },
  { key: 'manual-chatgpt', label: 'ChatGPT tokens' },
  { key: 'back', label: 'Back' },
];

const LOGOUT_MENU: MenuItem[] = [
  { key: 'logout-claude', label: 'Claude' },
  { key: 'logout-chatgpt', label: 'ChatGPT' },
  { key: 'logout-both', label: 'Both' },
  { key: 'back', label: 'Back' },
];

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getApiViewLines(provider: 'openai' | 'claude' | 'openrouter'): string[] {
  if (provider === 'claude') {
    return [
      'Claude API',
      '  Base URL: http://localhost:3344',
      '  POST /v1/messages',
      '  GET  /v1/models',
    ];
  }

  if (provider === 'openrouter') {
    return [
      'OpenRouter API',
      '  Base URL: http://localhost:3344/v1',
      '  POST /chat/completions',
      '  POST /responses',
      '  GET  /models?provider=openrouter',
      '',
      '  Model IDs:',
      '    openai/gpt-5.4',
      '    anthropic/claude-sonnet-4-6',
    ];
  }

  return [
    'OpenAI API',
    '  Base URL: http://localhost:3344/v1',
    '  POST /chat/completions',
    '  POST /responses',
    '  GET  /models',
  ];
}

function getApiMenuItems(
  provider: 'openai' | 'claude' | 'openrouter'
): MenuItem[] {
  return [
    { key: 'back', label: 'Back' },
    {
      key: 'select-api-openai',
      label: `${provider === 'openai' ? '[x]' : '[ ]'} OpenAI`,
    },
    {
      key: 'select-api-claude',
      label: `${provider === 'claude' ? '[x]' : '[ ]'} Claude`,
    },
    {
      key: 'select-api-openrouter',
      label: `${provider === 'openrouter' ? '[x]' : '[ ]'} OpenRouter`,
    },
  ];
}

function extractTextFromAnthropicResponse(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return '';
  }

  const block = content.find(
    (entry) =>
      !!entry &&
      typeof entry === 'object' &&
      (entry as { type?: unknown }).type === 'text' &&
      typeof (entry as { text?: unknown }).text === 'string'
  ) as { text?: string } | undefined;

  return block?.text?.trim() || '';
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
      const data = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');

      if (!data) {
        continue;
      }

      try {
        const payload = JSON.parse(data) as { type?: unknown; delta?: unknown };
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

async function buildOpenAIHeaders(): Promise<Record<string, string>> {
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

async function fetchAnthropicModels(): Promise<string[]> {
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

  const models = (payload as { data?: Array<{ id?: string }> }).data || [];
  return models.map((model) => model.id || 'unknown');
}

async function fetchOpenAIModels(): Promise<string[]> {
  const headers = await buildOpenAIHeaders();
  delete headers['Content-Type'];

  const response = await fetch(OPENAI_MODELS_URL, {
    method: 'GET',
    headers,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(payload));
  }

  const models = (payload as { models?: Array<{ slug?: string }> }).models || [];
  return models.map((model) => model.slug || 'unknown');
}

async function verifyAnthropicSubscription(): Promise<string> {
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

  const model = (payload as { model?: string }).model || 'unknown';
  return `${model} -> ${extractTextFromAnthropicResponse(payload) || '(empty response)'}`;
}

async function verifyOpenAISubscription(): Promise<string> {
  const headers = await buildOpenAIHeaders();
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

  return `gpt-5.4 -> ${await readChatGPTSSEText(response) || '(empty response)'}`;
}

async function loadAuthSnapshot(): Promise<AuthSnapshot> {
  const routerRunning = await isRouterRunning();
  const tokens = await loadTokens();
  const chatGPTAuthState = await loadOpenAIAuthState();
  const envOpenAIKey = process.env.CODE_ROUTER_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const savedOpenAIKey = chatGPTAuthState?.apiKey ?? null;
  const chatGPTConfigured = Boolean(envOpenAIKey) || Boolean(savedOpenAIKey);
  const chatGPTSource = envOpenAIKey
    ? 'environment'
    : chatGPTAuthState
      ? `${chatGPTAuthState.source} auth file`
      : null;

  if (!tokens) {
    return {
      routerRunning,
      claudeConfigured: false,
      claudeExpired: false,
      claudeScope: null,
      claudeExpiresInMinutes: null,
      chatgptConfigured: chatGPTConfigured,
      chatgptSource: chatGPTSource,
      chatgptMaskedToken: savedOpenAIKey || envOpenAIKey ? maskApiKey(savedOpenAIKey || envOpenAIKey || '') : null,
      chatgptMaskedRefresh: chatGPTAuthState?.refreshToken ? maskApiKey(chatGPTAuthState.refreshToken) : null,
      chatgptAccountId: chatGPTAuthState?.accountId || null,
    };
  }

  const expiresInMinutes = tokens.expires_at
    ? Math.floor((tokens.expires_at - Date.now()) / 1000 / 60)
    : null;

  return {
    routerRunning,
    claudeConfigured: true,
    claudeExpired: isTokenExpired(tokens),
    claudeScope: tokens.scope,
    claudeExpiresInMinutes: expiresInMinutes,
    chatgptConfigured: chatGPTConfigured,
    chatgptSource: chatGPTSource,
    chatgptMaskedToken: savedOpenAIKey || envOpenAIKey ? maskApiKey(savedOpenAIKey || envOpenAIKey || '') : null,
    chatgptMaskedRefresh: chatGPTAuthState?.refreshToken ? maskApiKey(chatGPTAuthState.refreshToken) : null,
    chatgptAccountId: chatGPTAuthState?.accountId || null,
  };
}

async function deleteIfExists(path: string): Promise<void> {
  try {
    const fs = await import('fs/promises');
    await fs.unlink(path);
  } catch {
    return;
  }
}

async function isRouterRunning(port = 3344): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function startRouterDetached(port = 3344): number | undefined {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npmCommand, ['run', 'router', '--', '--port', String(port)], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

function stopRouterProcess(pid: number): void {
  if (process.platform === 'win32') {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    return;
  }

  process.kill(-pid, 'SIGTERM');
}

function findRouterPids(port = 3344): number[] {
  if (process.platform === 'win32') {
    return [];
  }

  try {
    const output = execSync(`lsof -ti tcp:${port}`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();

    return output
      .split('\n')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function usePrompt() {
  const [promptRequest, setPromptRequest] = useState<PromptRequest | null>(null);
  const promptRef = useRef<PromptRequest | null>(null);

  useEffect(() => {
    promptRef.current = promptRequest;
  }, [promptRequest]);

  const ask = useCallback((label: string) => {
    return new Promise<string>((resolve) => {
      setPromptRequest({ label, value: '', resolve });
    });
  }, []);

  const append = useCallback((char: string) => {
    setPromptRequest((current) => (current ? { ...current, value: current.value + char } : current));
  }, []);

  const backspace = useCallback(() => {
    setPromptRequest((current) =>
      current ? { ...current, value: current.value.slice(0, -1) } : current
    );
  }, []);

  const submit = useCallback(() => {
    const current = promptRef.current;
    if (!current) {
      return;
    }

    current.resolve(current.value);
    setPromptRequest(null);
  }, []);

  const cancel = useCallback(() => {
    const current = promptRef.current;
    if (!current) {
      return;
    }

    current.resolve('/back');
    setPromptRequest(null);
  }, []);

  return { promptRequest, ask, append, backspace, submit, cancel };
}

function App() {
  const { exit } = useApp();
  const windowHeight = Math.max(20, (process.stdout.rows || 24) - 1);
  const [screen, setScreen] = useState<'root' | 'serve' | 'auth' | 'manual' | 'logout' | 'view'>(
    'root'
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [viewOffset, setViewOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [viewTitle, setViewTitle] = useState('VIEW');
  const [viewLines, setViewLines] = useState<string[]>([]);
  const [viewBackScreen, setViewBackScreen] = useState<'root' | 'serve'>('root');
  const [apiProvider, setApiProvider] = useState<'openai' | 'claude' | 'openrouter'>('openai');
  const [authSnapshot, setAuthSnapshot] = useState<AuthSnapshot | null>(null);
  const { promptRequest, ask, append, backspace, submit, cancel } = usePrompt();
  const routerPidRef = useRef<number | null>(null);

  const showView = useCallback(
    (title: string, lines: string[], backScreen: 'root' | 'serve' = 'root') => {
      setViewTitle(title);
      setViewLines(lines);
      setViewOffset(0);
      setViewBackScreen(backScreen);
      setScreen('view');
    },
    []
  );

  const stopTrackedRouter = useCallback(() => {
    if (!routerPidRef.current) {
      return false;
    }

    try {
      stopRouterProcess(routerPidRef.current);
    } catch {
      routerPidRef.current = null;
      return false;
    }

    routerPidRef.current = null;
    return true;
  }, []);

  const refreshAuth = useCallback(async () => {
    setAuthSnapshot(await loadAuthSnapshot());
  }, []);

  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  const menuItems = useMemo(() => {
    switch (screen) {
      case 'serve':
        return SERVE_MENU;
      case 'auth':
        return AUTH_MENU;
      case 'manual':
        return MANUAL_TOKEN_MENU;
      case 'logout':
        return LOGOUT_MENU;
      case 'view':
        if (viewTitle === 'APIS') {
          return getApiMenuItems(apiProvider);
        }
        return [{ key: 'back', label: 'Back' }] satisfies MenuItem[];
      default:
        return ROOT_MENU.map((item) =>
          item.key === 'serve' && authSnapshot?.routerRunning
            ? { ...item, label: 'Serve ✓ running' }
            : item
        );
    }
  }, [apiProvider, authSnapshot?.routerRunning, screen, viewTitle]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [screen]);

  useEffect(
    () => () => {
      stopTrackedRouter();
    },
    [stopTrackedRouter]
  );

  const maxViewLines = Math.max(6, windowHeight - 18);
  const visibleViewLines = useMemo(
    () => viewLines.slice(viewOffset, viewOffset + maxViewLines),
    [maxViewLines, viewLines, viewOffset]
  );

  const runTask = useCallback(
    async (task: () => Promise<void>) => {
      setBusy(true);
      try {
        await task();
      } catch (error) {
        showView('ERROR', [`❌ ${formatError(error)}`]);
      } finally {
        await refreshAuth();
        setBusy(false);
      }
    },
    [refreshAuth, showView]
  );

  const handleSelection = useCallback(
    async (item: MenuItem) => {
      if (item.key === 'back') {
        setScreen(screen === 'view' ? viewBackScreen : 'root');
        return;
      }

      switch (item.key) {
        case 'serve':
          setScreen('serve');
          return;
        case 'auth':
          setScreen('auth');
          return;
        case 'start-serve':
          await runTask(async () => {
            const port = 3344;
            if (await isRouterRunning(port)) {
              await refreshAuth();
              showView('SERVE', [`Router is already running on http://localhost:${port}`], 'serve');
              return;
            }

            routerPidRef.current = startRouterDetached(port) ?? null;
            await new Promise((resolve) => setTimeout(resolve, 1500));
            const running = await isRouterRunning(port);
            await refreshAuth();
            showView(
              'SERVE',
              running
                ? [`Router is running on http://localhost:${port}`]
                : [
                    `Started router process for http://localhost:${port}`,
                    'Health check may take another moment.',
                  ],
              'serve'
            );
          });
          return;
        case 'show-apis':
          setApiProvider('openai');
          showView('APIS', getApiViewLines('openai'), 'serve');
          await refreshAuth();
          return;
        case 'select-api-openai':
          setApiProvider('openai');
          setViewLines(getApiViewLines('openai'));
          setViewOffset(0);
          return;
        case 'select-api-claude':
          setApiProvider('claude');
          setViewLines(getApiViewLines('claude'));
          setViewOffset(0);
          return;
        case 'select-api-openrouter':
          setApiProvider('openrouter');
          setViewLines(getApiViewLines('openrouter'));
          setViewOffset(0);
          return;
        case 'stop-serve':
          await runTask(async () => {
            const port = 3344;
            const stoppedTrackedRouter = stopTrackedRouter();
            const discoveredPids = stoppedTrackedRouter ? [] : findRouterPids(port);

            if (!stoppedTrackedRouter && discoveredPids.length === 0) {
              await refreshAuth();
              showView('SERVE', [`Router is not running on http://localhost:${port}`], 'serve');
              return;
            }

            if (!stoppedTrackedRouter) {
              let stopFailed = false;
              for (const pid of discoveredPids) {
                try {
                  process.kill(pid, 'SIGTERM');
                } catch {
                  stopFailed = true;
                }
              }

              if (stopFailed) {
                await refreshAuth();
                showView('SERVE', [`Unable to stop router on http://localhost:${port}`], 'serve');
                return;
              }
            }

            await new Promise((resolve) => setTimeout(resolve, 500));
            const running = await isRouterRunning(port);
            await refreshAuth();
            showView(
              'SERVE',
              running
                ? [`Router is still running on http://localhost:${port}`]
                : [`Router stopped on http://localhost:${port}`],
              'serve'
            );
          });
          return;
        case 'manual-token':
          setScreen('manual');
          return;
        case 'logout':
          setScreen('logout');
          return;
        case 'exit':
          stopTrackedRouter();
          exit();
          return;
        case 'claude-oauth':
          await runTask(async () => {
            const { code, verifier, state } = await startOAuthFlow(ask);
            const tokens = await exchangeCodeForTokens(code, verifier, state);
            await saveTokens(tokens);
            showView('AUTH', ['✅ Claude MAX authentication saved.']);
          });
          return;
        case 'chatgpt-oauth':
          await runTask(async () => {
            const result = await runOpenAIOAuthFlow(ask);
            await saveOpenAIAuthState({
              source: 'oauth',
              apiKey: result.accessToken,
              accessToken: result.oauthAccessToken,
              accountId: result.accountId,
              refreshToken: result.refreshToken,
              accessTokenExpiresAt: result.accessTokenExpiresAt,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            showView('AUTH', ['✅ ChatGPT OAuth saved.']);
          });
          return;
        case 'list-models':
          await runTask(async () => {
            const [anthropicModels, openAIModels] = await Promise.allSettled([
              fetchAnthropicModels(),
              fetchOpenAIModels(),
            ]);
            const lines: string[] = ['Claude'];
            if (anthropicModels.status === 'fulfilled') {
              lines.push(...anthropicModels.value.map((model) => `  ${model}`));
            } else {
              lines.push(`  ❌ ${formatError(anthropicModels.reason)}`);
            }
            lines.push('');
            lines.push('ChatGPT');
            if (openAIModels.status === 'fulfilled') {
              lines.push(...openAIModels.value.map((model) => `  ${model}`));
            } else {
              lines.push(`  ❌ ${formatError(openAIModels.reason)}`);
            }
            showView('MODELS', lines);
          });
          return;
        case 'verify':
          await runTask(async () => {
            const [anthropicResult, openAIResult] = await Promise.allSettled([
              verifyAnthropicSubscription(),
              verifyOpenAISubscription(),
            ]);
            const lines = [
              anthropicResult.status === 'fulfilled'
                ? `✅ Claude: ${anthropicResult.value}`
                : `❌ Claude: ${formatError(anthropicResult.reason)}`,
              openAIResult.status === 'fulfilled'
                ? `✅ ChatGPT: ${openAIResult.value}`
                : `❌ ChatGPT: ${formatError(openAIResult.reason)}`,
            ];
            showView('VERIFY', lines);
          });
          return;
        case 'manual-claude':
          await runTask(async () => {
            const accessToken = (await ask('Claude access token [/back]')).trim();
            if (accessToken.toLowerCase() === '/back') {
              setScreen('manual');
              return;
            }

            const refreshToken = (await ask('Claude refresh token [/back]')).trim();
            if (refreshToken.toLowerCase() === '/back') {
              setScreen('manual');
              return;
            }

            const scope = (await ask('Claude scope [blank = default] [/back]')).trim();
            if (scope.toLowerCase() === '/back') {
              setScreen('manual');
              return;
            }

            const hoursInput = (await ask('Hours until expiry [8] [/back]')).trim();
            if (hoursInput.toLowerCase() === '/back') {
              setScreen('manual');
              return;
            }

            if (!accessToken || !refreshToken) {
              throw new Error('Claude access token and refresh token are required');
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
            showView('MANUAL TOKENS', ['✅ Claude tokens saved.']);
          });
          return;
        case 'manual-chatgpt':
          await runTask(async () => {
            const apiKey = (await ask('ChatGPT ready-to-use token/API key [/back]')).trim();
            if (apiKey.toLowerCase() === '/back') {
              setScreen('manual');
              return;
            }

            const accessToken = (await ask('ChatGPT OAuth access token (optional) [/back]')).trim();
            if (accessToken.toLowerCase() === '/back') {
              setScreen('manual');
              return;
            }

            const refreshToken = (await ask('ChatGPT refresh token (optional) [/back]')).trim();
            if (refreshToken.toLowerCase() === '/back') {
              setScreen('manual');
              return;
            }

            const accountId = (await ask('ChatGPT account id (optional) [/back]')).trim();
            if (accountId.toLowerCase() === '/back') {
              setScreen('manual');
              return;
            }

            if (!apiKey) {
              throw new Error('ChatGPT token is required');
            }

            if (accessToken || refreshToken || accountId) {
              await saveOpenAIAuthState({
                source: 'oauth',
                apiKey,
                accessToken: accessToken || undefined,
                refreshToken: refreshToken || undefined,
                accountId: accountId || undefined,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              });
            } else {
              await saveOpenAIKey(apiKey);
            }

            showView('MANUAL TOKENS', ['✅ ChatGPT token saved.']);
          });
          return;
        case 'logout-claude':
        case 'logout-chatgpt':
        case 'logout-both':
          await runTask(async () => {
            const confirm = (await ask('Type yes to confirm logout')).trim().toLowerCase();
            if (confirm !== 'yes') {
              showView('LOGOUT', ['Logout cancelled.']);
              return;
            }

            if (item.key === 'logout-claude' || item.key === 'logout-both') {
              await deleteIfExists(TOKEN_FILE);
            }

            if (item.key === 'logout-chatgpt' || item.key === 'logout-both') {
              await deleteIfExists(CHATGPT_KEY_FILE);
            }

            showView('LOGOUT', ['✅ Stored credentials removed.']);
          });
          return;
        default:
          return;
      }
    },
    [ask, exit, refreshAuth, runTask, screen, showView, stopTrackedRouter, viewBackScreen]
  );

  useInput((
    input: string,
    key: {
      escape: boolean;
      return: boolean;
      backspace: boolean;
      delete: boolean;
      ctrl: boolean;
      meta: boolean;
      upArrow: boolean;
      downArrow: boolean;
    }
  ) => {
    if (promptRequest) {
      if (key.escape) {
        cancel();
        return;
      }

      if (key.return) {
        submit();
        return;
      }

      if (key.backspace || key.delete) {
        backspace();
        return;
      }

      if (!key.ctrl && !key.meta && input) {
        append(input);
      }

      return;
    }

    if (busy) {
      return;
    }

    if (key.ctrl && input === 'c') {
      stopTrackedRouter();
      exit();
      return;
    }

    if (key.escape) {
      if (screen !== 'root') {
        setScreen('root');
        setViewOffset(0);
      }
      return;
    }

    if (screen === 'view' && !promptRequest) {
      if (viewTitle === 'APIS') {
        if (key.upArrow) {
          setSelectedIndex((current) => (current - 1 + menuItems.length) % menuItems.length);
          return;
        }

        if (key.downArrow) {
          setSelectedIndex((current) => (current + 1) % menuItems.length);
          return;
        }
      }

      if (key.upArrow) {
        setViewOffset((current) => Math.max(0, current - 1));
        return;
      }

      if (key.downArrow) {
        setViewOffset((current) => Math.min(Math.max(0, viewLines.length - maxViewLines), current + 1));
        return;
      }
    }

    if (key.upArrow) {
      setSelectedIndex((current) => (current - 1 + menuItems.length) % menuItems.length);
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((current) => (current + 1) % menuItems.length);
      return;
    }

    if (key.return) {
      void handleSelection(menuItems[selectedIndex]!);
      return;
    }

    const numericChoice = Number(input);
    if (Number.isInteger(numericChoice) && numericChoice >= 1 && numericChoice <= menuItems.length) {
      setSelectedIndex(numericChoice - 1);
      void handleSelection(menuItems[numericChoice - 1]!);
    }
  });

  return (
    <Box
      borderStyle="round"
      borderColor="blue"
      flexDirection="column"
      paddingX={1}
      paddingY={0}
      height={windowHeight}
    >
      <Box flexDirection="row">
        <Box flexDirection="column" width="50%" paddingRight={2}>
          <Text> ██████╗ ██████╗</Text>
          <Text>██╔════╝ ██╔══██╗</Text>
          <Text>██║      ██████╔╝  CODE</Text>
          <Text>██║      ██╔══██╗  ROUTER</Text>
          <Text>╚██████╗ ██║  ██║</Text>
          <Text> ╚═════╝ ╚═╝  ╚═╝</Text>
          <Text color="gray">Use arrows or number keys. Press Enter to select.</Text>
        </Box>

        <Box borderLeft borderColor="blue" paddingLeft={2} paddingTop={1} flexDirection="column" width="50%">
          <Text color="gray">{`v${VERSION}`}</Text>
          <Text bold>STATUS</Text>
          <Text>
            Claude:{' '}
            {authSnapshot?.claudeConfigured ? <Text color="green">✓ configured</Text> : 'not configured'}
          </Text>
          <Text>
            ChatGPT:{' '}
            {authSnapshot?.chatgptConfigured ? <Text color="green">✓ configured</Text> : 'not configured'}
          </Text>
        </Box>
      </Box>

      <Box marginTop={1} borderTop borderColor="blue" width="100%" />

      <Box paddingTop={1}>
        <Box flexDirection="row" width="100%">
          <Box flexDirection="column" width="50%" paddingRight={2}>
            <Text bold>
              {screen === 'root'
                ? 'MENU'
                : screen === 'auth'
                  ? 'AUTH'
                  : screen === 'manual'
                    ? 'MANUAL TOKENS'
                    : screen === 'logout'
                      ? 'LOGOUT'
                      : 'MENU'}
            </Text>
            {menuItems.map((item, index) => (
              <Text key={item.key} color={index === selectedIndex ? 'cyan' : undefined}>
                {screen === 'view' && viewTitle === 'APIS'
                  ? `${index === selectedIndex ? '›' : ' '} ${item.label}`
                  : `${index === selectedIndex ? '›' : ' '} ${index + 1}. ${item.label}`}
              </Text>
            ))}
          </Box>

          <Box borderLeft borderColor="blue" paddingLeft={2} flexDirection="column" width="50%">
            {screen === 'view' ? (
              <Box flexDirection="column">
                {visibleViewLines.map((line, index) => (
                  <Text key={`${index}-${line}`}>{line || ' '}</Text>
                ))}
                {viewLines.length > maxViewLines ? (
                  <Text color="gray">
                    {`Scroll ${viewOffset + 1}-${Math.min(viewOffset + maxViewLines, viewLines.length)} of ${viewLines.length}`}
                  </Text>
                ) : null}
              </Box>
            ) : null}

            {promptRequest ? (
              <Box marginTop={1} flexDirection="column">
                <Text bold>INPUT</Text>
                <Text color="yellow">
                  {promptRequest.label}: {promptRequest.value}
                </Text>
              </Box>
            ) : null}

            {busy ? (
              <Box marginTop={1}>
                <Text color="yellow">Working...</Text>
              </Box>
            ) : null}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

render(<App />);
