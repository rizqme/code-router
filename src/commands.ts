import readline from 'readline';
import {
  getValidAccessToken,
  isTokenExpired,
  loadTokens,
  saveTokens,
  TOKEN_FILE,
} from './token-manager.js';
import { exchangeCodeForTokens, startOAuthFlow } from './oauth.js';
import { runOpenAIOAuthFlow } from './openai-oauth.js';
import {
  CHATGPT_KEY_FILE,
  getValidOpenAIAccessToken,
  loadOpenAIAuthState,
  saveOpenAIAuthState,
} from './openai-token-manager.js';

export type ProviderSelection = 'all' | 'claude' | 'openai' | 'openrouter';

type StatusSnapshot = {
  routerRunning: boolean;
  claudeConfigured: boolean;
  claudeExpired: boolean;
  claudeExpiresInMinutes: number | null;
  chatgptConfigured: boolean;
  chatgptSource: string | null;
};

type ModelsResult = {
  claude?: string[];
  openai?: string[];
  openrouter?: string[];
  errors: Partial<Record<'claude' | 'openai' | 'openrouter', string>>;
};

type VerifyResult = {
  claude?: string;
  openai?: string;
  errors: Partial<Record<'claude' | 'openai', string>>;
};

const OPENAI_MODELS_URL =
  'https://chatgpt.com/backend-api/codex/models?client_version=0.114.0';
const OPENAI_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA =
  'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function supportsPromptInput(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function createAsk() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt: string) =>
    new Promise<string>((resolve) => {
      rl.question(prompt, resolve);
    });

  return {
    ask,
    close: () => rl.close(),
  };
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

  const payload = (await response.json()) as { data?: Array<{ id?: string }> };
  if (!response.ok) {
    throw new Error(JSON.stringify(payload));
  }

  return (payload.data || []).map((model) => model.id || 'unknown');
}

async function fetchOpenAIModels(): Promise<string[]> {
  const headers = await buildOpenAIHeaders();
  delete headers['Content-Type'];

  const response = await fetch(OPENAI_MODELS_URL, {
    method: 'GET',
    headers,
  });

  const payload = (await response.json()) as { models?: Array<{ slug?: string }> };
  if (!response.ok) {
    throw new Error(JSON.stringify(payload));
  }

  return (payload.models || []).map((model) => model.slug || 'unknown');
}

async function verifyAnthropicSubscription(): Promise<string> {
  const accessToken = await getValidAccessToken();
  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
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

async function deleteIfExists(path: string): Promise<void> {
  try {
    const fs = await import('fs/promises');
    await fs.unlink(path);
  } catch {
    return;
  }
}

export async function loadStatusSnapshot(): Promise<StatusSnapshot> {
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

  return {
    routerRunning: await isRouterRunning(),
    claudeConfigured: Boolean(tokens),
    claudeExpired: tokens ? isTokenExpired(tokens) : false,
    claudeExpiresInMinutes:
      tokens?.expires_at ? Math.floor((tokens.expires_at - Date.now()) / 1000 / 60) : null,
    chatgptConfigured: chatGPTConfigured,
    chatgptSource: chatGPTSource,
  };
}

export function formatStatusText(status: StatusSnapshot): string {
  const lines = [
    'Status:',
    `  Claude: ${status.claudeConfigured ? 'configured' : 'not configured'}${
      status.claudeConfigured && status.claudeExpired ? ' (expired)' : ''
    }`,
    `  ChatGPT: ${status.chatgptConfigured ? 'configured' : 'not configured'}${
      status.chatgptConfigured && status.chatgptSource ? ` (${status.chatgptSource})` : ''
    }`,
    `  Router: ${status.routerRunning ? 'running' : 'not running'}`,
  ];

  return lines.join('\n');
}

export async function listModels(provider: ProviderSelection): Promise<ModelsResult> {
  const results: ModelsResult = { errors: {} };
  const wantsClaude = provider === 'all' || provider === 'claude' || provider === 'openrouter';
  const wantsOpenAI = provider === 'all' || provider === 'openai' || provider === 'openrouter';

  const [claudeResult, openAIResult] = await Promise.allSettled([
    wantsClaude ? fetchAnthropicModels() : Promise.resolve([]),
    wantsOpenAI ? fetchOpenAIModels() : Promise.resolve([]),
  ]);

  if (wantsClaude) {
    if (claudeResult.status === 'fulfilled') {
      results.claude = claudeResult.value;
    } else {
      results.errors.claude = formatError(claudeResult.reason);
    }
  }

  if (wantsOpenAI) {
    if (openAIResult.status === 'fulfilled') {
      results.openai = openAIResult.value;
    } else {
      results.errors.openai = formatError(openAIResult.reason);
    }
  }

  if (provider === 'all' || provider === 'openrouter') {
    const openRouterModels = [
      ...(results.openai || []).map((model) => `openai/${model}`),
      ...(results.claude || []).map((model) => `anthropic/${model}`),
    ];

    if (openRouterModels.length > 0) {
      results.openrouter = openRouterModels;
    } else if (provider === 'openrouter') {
      results.errors.openrouter =
        results.errors.openai || results.errors.claude || 'No models available';
    }
  }

  return results;
}

export function formatModelsText(provider: ProviderSelection, models: ModelsResult): string {
  const lines: string[] = [];

  const pushSection = (title: string, values?: string[], error?: string) => {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(title);
    if (values && values.length > 0) {
      lines.push(...values.map((value) => `  ${value}`));
      return;
    }
    if (error) {
      lines.push(`  ERROR: ${error}`);
      return;
    }
    lines.push('  No models available');
  };

  if (provider === 'all' || provider === 'claude') {
    pushSection('Claude', models.claude, models.errors.claude);
  }

  if (provider === 'all' || provider === 'openai') {
    pushSection('ChatGPT', models.openai, models.errors.openai);
  }

  if (provider === 'all' || provider === 'openrouter') {
    pushSection('OpenRouter', models.openrouter, models.errors.openrouter);
  }

  return lines.join('\n');
}

export async function verifySubscriptions(
  provider: Exclude<ProviderSelection, 'openrouter'>
): Promise<VerifyResult> {
  const results: VerifyResult = { errors: {} };
  const wantsClaude = provider === 'all' || provider === 'claude';
  const wantsOpenAI = provider === 'all' || provider === 'openai';

  const [claudeResult, openAIResult] = await Promise.allSettled([
    wantsClaude ? verifyAnthropicSubscription() : Promise.resolve(''),
    wantsOpenAI ? verifyOpenAISubscription() : Promise.resolve(''),
  ]);

  if (wantsClaude) {
    if (claudeResult.status === 'fulfilled') {
      results.claude = claudeResult.value;
    } else {
      results.errors.claude = formatError(claudeResult.reason);
    }
  }

  if (wantsOpenAI) {
    if (openAIResult.status === 'fulfilled') {
      results.openai = openAIResult.value;
    } else {
      results.errors.openai = formatError(openAIResult.reason);
    }
  }

  return results;
}

export function formatVerifyText(
  provider: Exclude<ProviderSelection, 'openrouter'>,
  results: VerifyResult
): string {
  const lines: string[] = [];

  if (provider === 'all' || provider === 'claude') {
    lines.push(
      results.claude ? `Claude: OK ${results.claude}` : `Claude: ERROR ${results.errors.claude}`
    );
  }

  if (provider === 'all' || provider === 'openai') {
    lines.push(
      results.openai ? `ChatGPT: OK ${results.openai}` : `ChatGPT: ERROR ${results.errors.openai}`
    );
  }

  return lines.join('\n');
}

export async function runClaudeOAuth(): Promise<void> {
  if (!supportsPromptInput()) {
    throw new Error('Claude OAuth requires an interactive terminal');
  }

  const prompt = createAsk();
  try {
    const { code, verifier, state } = await startOAuthFlow(prompt.ask);
    const tokens = await exchangeCodeForTokens(code, verifier, state);
    await saveTokens(tokens);
  } finally {
    prompt.close();
  }
}

export async function runOpenAIOAuth(): Promise<void> {
  if (!supportsPromptInput()) {
    throw new Error('ChatGPT OAuth requires an interactive terminal');
  }

  const prompt = createAsk();
  try {
    const result = await runOpenAIOAuthFlow(prompt.ask);
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
  } finally {
    prompt.close();
  }
}

export async function logout(target: 'claude' | 'openai' | 'all'): Promise<void> {
  if (target === 'claude' || target === 'all') {
    await deleteIfExists(TOKEN_FILE);
  }

  if (target === 'openai' || target === 'all') {
    await deleteIfExists(CHATGPT_KEY_FILE);
  }
}
