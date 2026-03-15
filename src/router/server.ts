#!/usr/bin/env node

import express, { Request, Response } from 'express';
import readline from 'readline';
import { getValidAccessToken, loadTokens, saveTokens } from '../token-manager.js';
import { startOAuthFlow, exchangeCodeForTokens } from '../oauth.js';
import {
  getValidOpenAIAccessToken,
  loadOpenAIAuthState,
} from '../openai-token-manager.js';
import { ensureRequiredSystemPrompt, stripUnknownFields } from './middleware.js';
import {
  AnthropicRequest,
  AnthropicResponse,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  OpenAIErrorResponse,
  OpenAIMessage,
  OpenAIResponsesRequest,
  OpenAIResponsesResponse,
  OpenAIToolCall,
  Provider,
} from '../types.js';
import { logger } from './logger.js';
import {
  translateOpenAIToAnthropic,
  translateAnthropicToOpenAI,
  translateAnthropicStreamToOpenAI,
  translateAnthropicErrorToOpenAI,
  translateAnthropicToOpenAIRequest,
  translateOpenAIToAnthropicResponse,
  translateOpenAIStreamToAnthropic,
  translateOpenAIErrorToAnthropic,
  validateOpenAIRequest,
} from './translator.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function askQuestion(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

function toStringHeader(value: string | string[] | undefined): string | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value;
}

function extractBearerToken(req: Request): string | null {
  return toStringHeader(req.headers['authorization'])
    ?.trim()
    .startsWith('Bearer ')
    ? (toStringHeader(req.headers['authorization']) as string).substring(7)
    : null;
}

function extractApiKey(req: Request): string | null {
  return toStringHeader(req.headers['x-api-key'])?.trim() ?? null;
}

function isOpenAIKey(token?: string | null): boolean {
  return Boolean(token && token.trim().length > 0);
}

let openAIAuth = {
  sourceConfigured: false,
  source: null as 'env' | 'manual' | 'oauth' | null,
  authorization: null as string | null,
  accountId: undefined as string | undefined,
};
let anthropicAuthConfigured = false;

type OpenAIAuthContext = {
  authorization: string;
  accountId?: string;
};

type OpenAIProviderHint = Pick<OpenAIChatCompletionRequest, 'model'>;

type ExternalProvider = Provider | 'openrouter';

function normalizeProvider(value: string | null | undefined): Provider | null {
  if (!value) return null;
  const normalized = value.toLowerCase().trim();
  if (normalized === 'openai') return 'openai';
  if (normalized === 'anthropic' || normalized === 'claude') return 'anthropic';
  return null;
}

function normalizeExternalProvider(value: string | null | undefined): ExternalProvider | null {
  if (!value) return null;
  const normalized = value.toLowerCase().trim();
  if (normalized === 'openrouter') return 'openrouter';
  return normalizeProvider(normalized);
}

function normalizeRequestedModelName(model?: string | null): string {
  if (!model) return '';
  if (model.startsWith('openai/')) return model.slice('openai/'.length);
  if (model.startsWith('anthropic/')) return model.slice('anthropic/'.length);
  return model;
}

function formatOpenRouterModelName(model?: string | null): string {
  const normalizedModel = normalizeRequestedModelName(model);
  if (!normalizedModel) return '';

  if (normalizedModel.startsWith('gpt-')) {
    return `openai/${normalizedModel}`;
  }

  if (normalizedModel.startsWith('claude-')) {
    return `anthropic/${normalizedModel}`;
  }

  return normalizedModel;
}

function resolveApiMode(
  req: Request,
  request?: OpenAIProviderHint
): 'native' | 'openrouter' {
  const headerHint =
    normalizeExternalProvider(toStringHeader(req.headers['x-code-router-provider'])) ||
    normalizeExternalProvider(toStringHeader(req.headers['x-router-provider'])) ||
    normalizeExternalProvider(toStringHeader(req.headers['provider']));
  if (headerHint === 'openrouter') {
    return 'openrouter';
  }

  const queryHint = normalizeExternalProvider(
    typeof req.query.provider === 'string' ? req.query.provider : null
  );
  if (queryHint === 'openrouter') {
    return 'openrouter';
  }

  if (
    request?.model &&
    (request.model.startsWith('openai/') || request.model.startsWith('anthropic/'))
  ) {
    return 'openrouter';
  }

  return 'native';
}

function formatModelForApiMode(model: string, apiMode: 'native' | 'openrouter'): string {
  return apiMode === 'openrouter' ? formatOpenRouterModelName(model) : model;
}

function sanitizeToken(token: string | undefined): string | undefined {
  if (!token) return token;
  if (!token.startsWith('Bearer ')) return token;
  const actual = token.slice(7);
  return `Bearer ${actual.slice(0, 6)}...${actual.slice(-4)}`;
}

function extractAccountIdFromJwt(token: string): string | undefined {
  const tokenParts = token.split('.');
  if (tokenParts.length < 2) {
    return undefined;
  }

  try {
    const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64url').toString('utf8')) as {
      [key: string]: unknown;
    };
    const authObject = payload['https://api.openai.com/auth'];
    if (typeof authObject !== 'object' || !authObject) {
      return undefined;
    }

    const accountId = (authObject as { [key: string]: unknown }).chatgpt_account_id;
    return typeof accountId === 'string' && accountId.trim().length > 0 ? accountId.trim() : undefined;
  } catch {
    return undefined;
  }
}

function buildOpenAIRequestHeaders(
  auth: OpenAIAuthContext,
  requestId: string,
  includeContentType = true
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: auth.authorization,
    accept: 'text/event-stream',
    originator: 'Code Router',
    session_id: requestId,
  };

  if (includeContentType) {
    headers['Content-Type'] = 'application/json';
  }

  if (auth.accountId) {
    headers['ChatGPT-Account-ID'] = auth.accountId;
  }

  return headers;
}

function logOutgoingRequest(
  provider: 'anthropic' | 'openai',
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown
) {
  const maskedHeaders = { ...headers };
  if (maskedHeaders.Authorization) {
    maskedHeaders.Authorization = sanitizeToken(maskedHeaders.Authorization) || '';
  }
  logger.logUpstreamRequest(provider, method, url, maskedHeaders, body);
}

function resolveProviderHint(req: Request, request?: OpenAIProviderHint): Provider | null {
  const headerHint =
    normalizeProvider(toStringHeader(req.headers['x-code-router-provider'])) ||
    normalizeProvider(toStringHeader(req.headers['x-router-provider'])) ||
    normalizeProvider(toStringHeader(req.headers['provider']));

  if (headerHint) {
    return headerHint;
  }

  const queryHint = normalizeProvider(
    typeof req.query.provider === 'string' ? req.query.provider : null
  );
  if (queryHint) {
    return queryHint;
  }

  const requestedModel = normalizeRequestedModelName(request?.model);
  if (requestedModel.startsWith('claude-')) {
    return 'anthropic';
  }

  return null;
}

function resolveChatProvider(req: Request, request?: OpenAIProviderHint): Provider {
  const hinted = resolveProviderHint(req, request);
  const availability = getCachedSubscriptionAvailability();
  const requestedModelProvider = classifyModelProvider(request?.model);

  if (availability.openai && !availability.anthropic) {
    return 'openai';
  }

  if (availability.anthropic && !availability.openai) {
    return 'anthropic';
  }

  if (requestedModelProvider === 'openai' && availability.openai) {
    return 'openai';
  }

  if (requestedModelProvider === 'anthropic' && availability.anthropic) {
    return 'anthropic';
  }

  if (hinted) {
    return hinted;
  }

  const defaultHint =
    normalizeProvider(process.env.CODE_ROUTER_DEFAULT_CHAT_PROVIDER) ||
    normalizeProvider(process.env.ROUTER_DEFAULT_PROVIDER);
  if (defaultHint) {
    return defaultHint;
  }

  const bearerToken = extractBearerToken(req);
  const apiKey = extractApiKey(req);

  if (isOpenAIKey(bearerToken) || isOpenAIKey(apiKey)) {
    return 'openai';
  }

  const envApiKey = process.env.CODE_ROUTER_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (openAIAuth.sourceConfigured || isOpenAIKey(envApiKey)) {
    return 'openai';
  }

  return 'anthropic';
}

function normalizeResponsesInput(
  input: unknown
): OpenAIMessage[] {
  if (typeof input === 'string') {
    const trimmedInput = input.trim();
    return trimmedInput.length > 0 ? [{ role: 'user', content: trimmedInput }] : [];
  }

  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((entry): OpenAIMessage[] => {
      if (typeof entry === 'string') {
        const trimmedEntry = entry.trim();
        return trimmedEntry.length > 0 ? [{ role: 'user', content: trimmedEntry }] : [];
      }

      if (!entry || typeof entry !== 'object') {
        return [];
      }

      const asObject = entry as Record<string, unknown>;
      const roleValue = typeof asObject.role === 'string' ? asObject.role : 'user';
      const role: 'assistant' | 'system' | 'user' =
        roleValue === 'assistant' || roleValue === 'system' || roleValue === 'user'
          ? roleValue
          : 'user';

      const contentValue = asObject.content;
      const normalizedContent =
        typeof contentValue === 'string'
          ? contentValue
          : Array.isArray(contentValue)
            ? contentValue.flatMap((block): Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } }> => {
                if (typeof block === 'string') {
                  return block.trim().length > 0 ? [{ type: 'text', text: block }] : [];
                }
                if (!block || typeof block !== 'object') {
                  return [];
                }
                const blockObject = block as Record<string, unknown>;
                const nestedImageUrl =
                  blockObject.image_url && typeof blockObject.image_url === 'object'
                    ? (blockObject.image_url as Record<string, unknown>)
                    : null;
                if (
                  (blockObject.type === 'input_image' || blockObject.type === 'image_url') &&
                  ((typeof blockObject.image_url === 'string' &&
                    blockObject.image_url.trim().length > 0) ||
                    (typeof nestedImageUrl?.url === 'string' &&
                      nestedImageUrl.url.trim().length > 0))
                ) {
                  const imageUrl =
                    typeof blockObject.image_url === 'string'
                      ? blockObject.image_url.trim()
                      : String(nestedImageUrl?.url).trim();
                  return [
                    {
                      type: 'image_url',
                      image_url: {
                        url: imageUrl,
                        ...(typeof blockObject.detail === 'string'
                          ? { detail: blockObject.detail }
                          : typeof nestedImageUrl?.detail === 'string'
                            ? { detail: nestedImageUrl.detail }
                          : {}),
                      },
                    },
                  ];
                }
                if (typeof blockObject.text === 'string' && blockObject.text.trim().length > 0) {
                  return [{ type: 'text', text: blockObject.text }];
                }
                if (
                  typeof blockObject.content === 'string' &&
                  blockObject.content.trim().length > 0
                ) {
                  return [{ type: 'text', text: blockObject.content }];
                }
                return [];
              })
            : '';

      if (typeof normalizedContent === 'string') {
        const trimmedContent = normalizedContent.trim();
        return trimmedContent.length > 0 ? [{ role, content: trimmedContent }] : [];
      }

      return normalizedContent.length > 0 ? [{ role, content: normalizedContent }] : [];
    });
}

function convertResponsesToOpenAIChatRequest(
  request: OpenAIResponsesRequest
): OpenAIChatCompletionRequest {
  const model =
    typeof request.model === 'string' && request.model.trim().length > 0 ? request.model : 'gpt-5';
  const instructions =
    typeof request.instructions === 'string' ? request.instructions.trim() : '';

  const maxOutputTokens =
    typeof request.max_output_tokens === 'number' && Number.isFinite(request.max_output_tokens)
      ? request.max_output_tokens
      : undefined;
  const maxTokens =
    typeof request.max_tokens === 'number' && Number.isFinite(request.max_tokens)
      ? request.max_tokens
      : undefined;
  const temperature =
    typeof request.temperature === 'number' && Number.isFinite(request.temperature)
      ? request.temperature
      : undefined;
  const topP =
    typeof request.top_p === 'number' && Number.isFinite(request.top_p) ? request.top_p : undefined;
  const stream = request.stream === true;

  const messages = normalizeResponsesInput(request.input);
  const allMessages: OpenAIMessage[] =
    instructions.length > 0 ? [{ role: 'system', content: instructions }, ...messages] : messages;

  return {
    model,
    messages: allMessages,
    max_tokens: maxOutputTokens ?? maxTokens,
    temperature,
    top_p: topP,
    stream,
    n: 1,
  };
}

async function hydrateOpenAIAuthState(): Promise<void> {
  if (openAIAuth.sourceConfigured && openAIAuth.authorization) {
    return;
  }

  const envApiKey = process.env.CODE_ROUTER_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (isOpenAIKey(envApiKey)) {
    openAIAuth = {
      sourceConfigured: true,
      source: 'env',
      authorization: `Bearer ${envApiKey}`,
      accountId: undefined,
    };
    return;
  }

  const storedAuth = await loadOpenAIAuthState();
  if (storedAuth?.apiKey && isOpenAIKey(storedAuth.apiKey)) {
    const source = storedAuth.source === 'oauth' ? 'oauth' : 'manual';
    openAIAuth = {
      sourceConfigured: true,
      source,
      authorization: `Bearer ${storedAuth.apiKey}`,
      accountId: storedAuth.accountId,
    };
    return;
  }

  openAIAuth = {
    sourceConfigured: false,
    source: null,
    authorization: null,
    accountId: undefined,
  };
}

async function resolveStoredOpenAIAuthorization(): Promise<string | null> {
  if (!openAIAuth.sourceConfigured || !openAIAuth.authorization) {
    return null;
  }

  if (openAIAuth.source !== 'oauth') {
    return openAIAuth.authorization;
  }

  try {
    const validToken = await getValidOpenAIAccessToken();
    return `Bearer ${validToken}`;
  } catch (error) {
    logger.error('Failed to refresh ChatGPT token:', error);
    return null;
  }
}

async function getOpenAIAuthorization(req: Request): Promise<OpenAIAuthContext | null> {
  const envApiKey = process.env.CODE_ROUTER_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (isOpenAIKey(envApiKey)) {
    return { authorization: `Bearer ${envApiKey}` };
  }

  if (!openAIAuth.authorization) {
    return null;
  }

  const stored = await resolveStoredOpenAIAuthorization();
  if (stored) {
    return {
      authorization: stored,
      accountId: openAIAuth.accountId,
    };
  }

  return null;
}

async function streamResponse(
  res: Response,
  body: AsyncIterable<Uint8Array | string>
): Promise<void> {
  try {
    for await (const chunk of body) {
      if (!res.writableEnded) {
        if (typeof chunk === 'string') {
          res.write(chunk);
        } else {
          res.write(Buffer.from(chunk));
        }
      }
    }
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
}

type ParsedSSEEvent = {
  event: string | null;
  data: string;
};

type CodexResponsesUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
};

function flattenOpenAIMessageContent(message: OpenAIMessage): string {
  const flattenTextContent = (content: OpenAIMessage['content']): string => {
    if (typeof content === 'string') {
      return content;
    }

    if (!Array.isArray(content)) {
      return '';
    }

    return content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .filter((part) => part.trim().length > 0)
      .join('\n\n');
  };

  if (message.role === 'tool') {
    const prefix = `[tool_result:${message.tool_call_id || 'unknown'}]`;
    const content = flattenTextContent(message.content).trim();
    return [prefix, content].filter((value) => value.length > 0).join('\n\n');
  }

  const content = flattenTextContent(message.content);
  if (!message.tool_calls || message.tool_calls.length === 0) {
    return content;
  }

  const toolCalls = message.tool_calls
    .map((toolCall) => `[tool_call:${toolCall.function.name}] ${toolCall.function.arguments}`)
    .join('\n\n');
  return [content, toolCalls].filter((value) => value.length > 0).join('\n\n');
}

function convertOpenAIMessageToResponsesContent(
  message: OpenAIMessage
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const textType = message.role === 'assistant' ? 'output_text' : 'input_text';

  if (typeof message.content === 'string') {
    const trimmedContent = message.content.trim();
    if (trimmedContent.length > 0) {
      blocks.push({ type: textType, text: trimmedContent });
    }
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text') {
        const trimmedText = part.text.trim();
        if (trimmedText.length > 0) {
          blocks.push({ type: textType, text: trimmedText });
        }
        continue;
      }

      if (
        message.role !== 'assistant' &&
        part.type === 'image_url' &&
        typeof part.image_url?.url === 'string' &&
        part.image_url.url.trim().length > 0
      ) {
        blocks.push({
          type: 'input_image',
          image_url: part.image_url.url.trim(),
          ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
        });
      }
    }
  }

  if (message.tool_calls && message.tool_calls.length > 0) {
    const toolCalls = message.tool_calls
      .map((toolCall) => `[tool_call:${toolCall.function.name}] ${toolCall.function.arguments}`)
      .join('\n\n')
      .trim();
    if (toolCalls.length > 0) {
      blocks.push({
        type: 'output_text',
        text: toolCalls,
      });
    }
  }

  return blocks;
}

function convertChatCompletionsToResponsesRequest(
  request: OpenAIChatCompletionRequest
): OpenAIResponsesRequest {
  const instructions = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => flattenOpenAIMessageContent(message).trim())
    .filter((value) => value.length > 0)
    .join('\n\n') || 'You are a helpful assistant.';

  const input = request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      type: 'message',
      role: message.role === 'tool' ? 'user' : message.role,
      content: convertOpenAIMessageToResponsesContent(message),
    }))
    .filter((message) => message.content.length > 0);

  const responsesRequest: OpenAIResponsesRequest = {
    model: request.model,
    instructions,
    input,
    parallel_tool_calls: true,
    reasoning: {
      effort: 'medium',
    },
    store: false,
    stream: true,
    text: {
      verbosity: 'low',
    },
  };

  if (request.tools && request.tools.length > 0) {
    responsesRequest.tools = request.tools.map((tool) => ({
      type: tool.type,
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }));
  }

  if (!request.tool_choice || request.tool_choice === 'auto' || request.tool_choice === 'none') {
    responsesRequest.tool_choice = request.tool_choice ?? 'auto';
  } else if (request.tool_choice.type === 'function') {
    responsesRequest.tool_choice = {
      type: 'function',
      name: request.tool_choice.function.name,
    };
  }

  return responsesRequest;
}

async function* parseSSEStream(
  stream: AsyncIterable<Uint8Array>
): AsyncGenerator<ParsedSSEEvent, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const separatorIndex = buffer.indexOf('\n\n');
      if (separatorIndex === -1) {
        break;
      }

      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      const lines = rawEvent.split('\n');
      let eventName: string | null = null;
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      if (eventName || dataLines.length > 0) {
        yield { event: eventName, data: dataLines.join('\n') };
      }
    }
  }
}

async function* encodeStringStream(
  stream: AsyncIterable<string>
): AsyncGenerator<Uint8Array, void, unknown> {
  const encoder = new TextEncoder();

  for await (const chunk of stream) {
    yield encoder.encode(chunk);
  }
}

function buildOpenAICompletionUsage(usage?: CodexResponsesUsage): OpenAIChatCompletionResponse['usage'] {
  const promptTokens = usage?.input_tokens || 0;
  const completionTokens = usage?.output_tokens || 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function extractTextFromCodexOutputItem(item: Record<string, unknown>): string {
  if (item.type !== 'message' || !Array.isArray(item.content)) {
    return '';
  }

  return item.content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }

      const contentPart = part as Record<string, unknown>;
      return contentPart.type === 'output_text' && typeof contentPart.text === 'string'
        ? contentPart.text
        : '';
    })
    .filter((part) => part.length > 0)
    .join('');
}

function translateCodexOutputItemToToolCall(
  item: Record<string, unknown>
): OpenAIToolCall | null {
  const itemType = typeof item.type === 'string' ? item.type : null;
  const callId = typeof item.call_id === 'string' ? item.call_id : null;

  if (itemType === 'function_call' && callId && typeof item.name === 'string') {
    return {
      id: callId,
      type: 'function',
      function: {
        name: item.name,
        arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
      },
    };
  }

  if (itemType === 'custom_tool_call' && callId && typeof item.name === 'string') {
    return {
      id: callId,
      type: 'function',
      function: {
        name: item.name,
        arguments: JSON.stringify({
          input: typeof item.input === 'string' ? item.input : '',
        }),
      },
    };
  }

  if (itemType === 'tool_search_call' && callId) {
    return {
      id: callId,
      type: 'function',
      function: {
        name: 'tool_search_call',
        arguments: JSON.stringify(item.arguments ?? {}),
      },
    };
  }

  if (itemType === 'local_shell_call' && callId) {
    const action =
      item.action && typeof item.action === 'object'
        ? (item.action as Record<string, unknown>)
        : null;
    const command = Array.isArray(action?.command)
      ? action.command.filter((entry): entry is string => typeof entry === 'string')
      : [];

    return {
      id: callId,
      type: 'function',
      function: {
        name: 'exec_command',
        arguments: JSON.stringify({
          cmd: command.join(' '),
        }),
      },
    };
  }

  return null;
}

async function readCodexResponsesAsChatCompletion(
  stream: AsyncIterable<Uint8Array>,
  model: string
): Promise<OpenAIChatCompletionResponse> {
  let responseId = `chatcmpl-${Math.random().toString(36).slice(2)}`;
  let content = '';
  let sawOutputTextDelta = false;
  let usage: CodexResponsesUsage | undefined;
  const toolCalls: OpenAIToolCall[] = [];
  const seenToolCallIds = new Set<string>();

  for await (const sseEvent of parseSSEStream(stream)) {
    if (!sseEvent.data) {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(sseEvent.data) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (parsed.type === 'response.created') {
      const response = parsed.response as Record<string, unknown> | undefined;
      if (response && typeof response.id === 'string') {
        responseId = response.id;
      }
      continue;
    }

    if (parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
      sawOutputTextDelta = true;
      content += parsed.delta;
      continue;
    }

    if (parsed.type === 'response.output_item.done' && parsed.item && typeof parsed.item === 'object') {
      const item = parsed.item as Record<string, unknown>;
      const toolCall = translateCodexOutputItemToToolCall(item);

      if (toolCall && !seenToolCallIds.has(toolCall.id)) {
        seenToolCallIds.add(toolCall.id);
        toolCalls.push(toolCall);
        logger.info(`  Codex output item: type=${item.type} name=${toolCall.function.name}`);
        continue;
      }

      if (!sawOutputTextDelta) {
        const outputText = extractTextFromCodexOutputItem(item);
        if (outputText.length > 0) {
          content += outputText;
        }
      }
    }

    if (parsed.type === 'response.completed') {
      const response = parsed.response as Record<string, unknown> | undefined;
      if (response && typeof response.id === 'string') {
        responseId = response.id;
      }
      if (response && typeof response.usage === 'object' && response.usage) {
        usage = response.usage as CodexResponsesUsage;
      }
    }
  }

  return {
    id: responseId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage: buildOpenAICompletionUsage(usage),
  };
}

async function* translateCodexResponsesStreamToChatCompletions(
  stream: AsyncIterable<Uint8Array>,
  model: string,
  messageId: string
): AsyncGenerator<string, void, unknown> {
  let emittedRole = false;
  let sawOutputTextDelta = false;
  let sawToolCall = false;
  let usage: CodexResponsesUsage | undefined;
  const emittedToolCallIds = new Set<string>();
  let nextToolCallIndex = 0;

  for await (const sseEvent of parseSSEStream(stream)) {
    if (!sseEvent.data) {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(sseEvent.data) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
      sawOutputTextDelta = true;
      if (!emittedRole) {
        emittedRole = true;
        yield `data: ${JSON.stringify({
          id: messageId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        })}\n\n`;
      }

      yield `data: ${JSON.stringify({
        id: messageId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: parsed.delta }, finish_reason: null }],
      })}\n\n`;
      continue;
    }

    if (parsed.type === 'response.output_item.done' && parsed.item && typeof parsed.item === 'object') {
      const item = parsed.item as Record<string, unknown>;
      const toolCall = translateCodexOutputItemToToolCall(item);

      if (toolCall && !emittedToolCallIds.has(toolCall.id)) {
        emittedToolCallIds.add(toolCall.id);
        sawToolCall = true;
        logger.info(`  Codex output item: type=${item.type} name=${toolCall.function.name}`);

        if (!emittedRole) {
          emittedRole = true;
          yield `data: ${JSON.stringify({
            id: messageId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          })}\n\n`;
        }

        yield `data: ${JSON.stringify({
          id: messageId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: nextToolCallIndex++,
                    id: toolCall.id,
                    type: 'function',
                    function: {
                      name: toolCall.function.name,
                      arguments: toolCall.function.arguments,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`;
        continue;
      }

      if (!sawOutputTextDelta) {
        const outputText = extractTextFromCodexOutputItem(item);
        if (outputText.length > 0) {
          if (!emittedRole) {
            emittedRole = true;
            yield `data: ${JSON.stringify({
              id: messageId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            })}\n\n`;
          }

          yield `data: ${JSON.stringify({
            id: messageId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: outputText }, finish_reason: null }],
          })}\n\n`;
        }
      }
      continue;
    }

    if (parsed.type === 'response.completed') {
      const response = parsed.response as Record<string, unknown> | undefined;
      if (response && typeof response.usage === 'object' && response.usage) {
        usage = response.usage as CodexResponsesUsage;
      }
    }
  }

  if (!emittedRole) {
    yield `data: ${JSON.stringify({
      id: messageId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    })}\n\n`;
  }

  yield `data: ${JSON.stringify({
    id: messageId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: sawToolCall ? 'tool_calls' : 'stop' }],
    usage: buildOpenAICompletionUsage(usage),
  })}\n\n`;
  yield 'data: [DONE]\n\n';
}

const endpointConfig = {
  anthropicEnabled: true,
  openaiEnabled: true,
  allowBearerPassthrough: true,
};

function parseArgs() {
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--version' || arg === '-v') {
      console.log(`CODER v${packageJson.version}`);
      process.exit(0);
    }

    if (arg === '--help' || arg === '-h') {
      showHelp();
      process.exit(0);
    }

    if (arg === '--quiet' || arg === '-q') {
      logger.setLevel('quiet');
    } else if (arg === '--minimal' || arg === '-m') {
      logger.setLevel('minimal');
    } else if (arg === '--verbose' || arg === '-V') {
      logger.setLevel('maximum');
    } else if (arg === '--port' || arg === '-p') {
      const portValue = args[i + 1];
      if (portValue && !portValue.startsWith('-')) {
        PORT = parseInt(portValue, 10);
        i++;
      }
    } else if (arg === '--enable-all-endpoints') {
      endpointConfig.anthropicEnabled = true;
      endpointConfig.openaiEnabled = true;
    } else if (arg === '--enable-openai') {
      endpointConfig.openaiEnabled = true;
    } else if (arg === '--disable-openai') {
      endpointConfig.openaiEnabled = false;
    } else if (arg === '--enable-anthropic') {
      endpointConfig.anthropicEnabled = true;
    } else if (arg === '--disable-anthropic') {
      endpointConfig.anthropicEnabled = false;
    } else if (arg === '--disable-bearer-passthrough') {
      endpointConfig.allowBearerPassthrough = false;
    }
  }

  if (!endpointConfig.anthropicEnabled && !endpointConfig.openaiEnabled) {
    console.error('Error: At least one endpoint must be enabled');
    console.error('Use --enable-anthropic or --enable-openai');
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
CODER v${packageJson.version}

Usage: npm run router [options]

Options:
  -h, --help                    Show this help message
  -v, --version                 Show version number
  -p, --port PORT               Port to listen on (default: 3344)

  Endpoint control (default: both enabled):
  --enable-anthropic             Enable Anthropic /v1/messages endpoint
  --disable-anthropic            Disable Anthropic endpoint
  --enable-openai                Enable OpenAI endpoints (/v1/chat/completions, /v1/responses)
  --disable-openai               Disable OpenAI endpoints
  --enable-all-endpoints         Enable all endpoints

  Authentication control (default: passthrough enabled):
  --disable-bearer-passthrough   Force requests to use router OAuth for Anthropic routes

  Verbosity:
  -q, --quiet                   No request logging
  -m, --minimal                 Minimal logging
  -V, --verbose                 Full request/response logging

Provider routing:
  /v1/messages, /v1/chat/completions and /v1/responses:
  - By default, requests with an OpenAI key (sk-*) route directly to ChatGPT
  - Requests without OpenAI key route to Anthropic MAX
  - Override with header x-code-router-provider: anthropic|openai
  - Override with query provider=anthropic|openai

Environment:
  ROUTER_PORT
  CODE_ROUTER_OPENAI_API_KEY
  OPENAI_API_KEY
  CODE_ROUTER_DEFAULT_CHAT_PROVIDER
  ANTHROPIC_DEFAULT_MODEL

Examples:
  npm run router -- --enable-openai --verbose
  ROUTER_PORT=8080 npm run router -- --enable-anthropic
`);
}

let PORT = process.env.ROUTER_PORT ? parseInt(process.env.ROUTER_PORT) : 3344;
parseArgs();

const app = express();

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA =
  'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';

const OPENAI_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const OPENAI_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
const OPENAI_MODELS_CLIENT_VERSION =
  process.env.CODE_ROUTER_OPENAI_CLIENT_VERSION || '0.114.0';
const MODEL_CACHE_REFRESH_MS = Number(process.env.CODE_ROUTER_MODEL_REFRESH_MS || 300000);

type CachedModelState = {
  raw: Record<string, unknown> | null;
  models: Record<string, unknown>[];
  fetchedAt: number | null;
  lastError: string | null;
  refreshing: Promise<void> | null;
};

const modelCache: Record<Provider, CachedModelState> = {
  openai: {
    raw: null,
    models: [],
    fetchedAt: null,
    lastError: null,
    refreshing: null,
  },
  anthropic: {
    raw: null,
    models: [],
    fetchedAt: null,
    lastError: null,
    refreshing: null,
  },
};

function extractOpenAIModels(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const models = (payload as { models?: unknown }).models;
  return Array.isArray(models)
    ? models.filter(
        (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object'
      )
    : [];
}

function extractAnthropicModels(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const models = (payload as { data?: unknown }).data;
  return Array.isArray(models)
    ? models.filter(
        (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object'
      )
    : [];
}

function getCachedSubscriptionAvailability(): Record<Provider, boolean> {
  return {
    openai: endpointConfig.openaiEnabled && modelCache.openai.models.length > 0,
    anthropic:
      endpointConfig.anthropicEnabled &&
      anthropicAuthConfigured &&
      modelCache.anthropic.models.length > 0,
  };
}

function classifyModelProvider(model?: string | null): Provider | null {
  const normalizedModel = normalizeRequestedModelName(model);
  if (!normalizedModel) {
    return null;
  }

  if (normalizedModel.startsWith('claude-')) {
    return 'anthropic';
  }

  if (normalizedModel.startsWith('gpt-')) {
    return 'openai';
  }

  return null;
}

function getLatestOpenAIModel(): string {
  const cachedModel = modelCache.openai.models.find((entry) => {
    const slug = typeof entry.slug === 'string' ? entry.slug : '';
    return slug.startsWith('gpt-') && entry.supported_in_api !== false;
  });

  return cachedModel && typeof cachedModel.slug === 'string' ? cachedModel.slug : 'gpt-5.4';
}

function getLatestAnthropicSonnetModel(): string {
  const cachedModel = modelCache.anthropic.models.find((entry) => {
    const id = typeof entry.id === 'string' ? entry.id : '';
    return id.includes('sonnet');
  });

  return cachedModel && typeof cachedModel.id === 'string'
    ? cachedModel.id
    : 'claude-sonnet-4-6';
}

function remapModelForProvider(provider: Provider, requestedModel: string): string {
  const requestedProvider = classifyModelProvider(requestedModel);

  if (provider === 'openai' && requestedProvider === 'anthropic') {
    return getLatestOpenAIModel();
  }

  if (provider === 'anthropic' && requestedProvider === 'openai') {
    return getLatestAnthropicSonnetModel();
  }

  return requestedModel;
}

function resolveProviderAndModel(
  req: Request,
  requestedModel: string,
  request?: OpenAIProviderHint
): { provider: Provider; model: string } {
  const normalizedModel = normalizeRequestedModelName(requestedModel);
  const normalizedRequest =
    request && request.model !== normalizedModel ? { ...request, model: normalizedModel } : request;
  const provider = resolveChatProvider(req, normalizedRequest);
  return {
    provider,
    model: remapModelForProvider(provider, normalizedModel),
  };
}

function logRoutingDecision(
  req: Request,
  requestedModel: string,
  resolvedProvider: Provider,
  resolvedModel: string
): void {
  const hintedProvider = resolveProviderHint(req, { model: requestedModel });
  const requestedModelProvider = classifyModelProvider(requestedModel);
  const availability = getCachedSubscriptionAvailability();
  logger.info(
    `  Routing decision: model=${requestedModel} model_provider=${requestedModelProvider || 'unknown'} hinted=${hintedProvider || 'none'} openai_available=${availability.openai} anthropic_available=${availability.anthropic} resolved_provider=${resolvedProvider} resolved_model=${resolvedModel}`
  );
}

function normalizeOpenRouterModelList(): Record<string, unknown>[] {
  return [
    ...modelCache.openai.models.map((entry) => {
      const slug = typeof entry.slug === 'string' ? entry.slug : '';
      return {
        provider: 'openrouter',
        backend_provider: 'openai',
        id: formatOpenRouterModelName(slug),
        slug: formatOpenRouterModelName(slug),
        canonical_slug: slug,
        display_name: entry.display_name ?? slug,
        supported_in_api: entry.supported_in_api ?? true,
        visibility: entry.visibility ?? 'list',
      };
    }),
    ...modelCache.anthropic.models.map((entry) => {
      const id = typeof entry.id === 'string' ? entry.id : '';
      return {
        provider: 'openrouter',
        backend_provider: 'anthropic',
        id: formatOpenRouterModelName(id),
        slug: formatOpenRouterModelName(id),
        canonical_slug: id,
        display_name: entry.display_name ?? id,
        type: entry.type ?? 'model',
      };
    }),
  ].filter((entry) => typeof entry.id === 'string' && entry.id.length > 0);
}

function normalizeCombinedModelList(): Record<string, unknown>[] {
  return [
    ...modelCache.openai.models.map((entry) => ({
      provider: 'openai',
      id: entry.slug,
      slug: entry.slug,
      display_name: entry.display_name ?? entry.slug,
      supported_in_api: entry.supported_in_api ?? true,
      visibility: entry.visibility ?? 'list',
    })),
    ...modelCache.anthropic.models.map((entry) => ({
      provider: 'anthropic',
      id: entry.id,
      slug: entry.id,
      display_name: entry.display_name ?? entry.id,
      type: entry.type ?? 'model',
    })),
  ];
}

async function refreshOpenAIModelCache(auth?: OpenAIAuthContext | null): Promise<void> {
  if (modelCache.openai.refreshing) {
    await modelCache.openai.refreshing;
    return;
  }

  modelCache.openai.refreshing = (async () => {
    let authorization = auth;

    if (!authorization) {
      const storedAuthorization = await resolveStoredOpenAIAuthorization();
      if (!storedAuthorization) {
        return;
      }

      authorization = {
        authorization: storedAuthorization,
        accountId: openAIAuth.accountId,
      };
    }

    const headers = buildOpenAIRequestHeaders(authorization, 'models-cache', false);
    const response = await fetch(
      `${OPENAI_MODELS_URL}?client_version=${encodeURIComponent(OPENAI_MODELS_CLIENT_VERSION)}`,
      {
        method: 'GET',
        headers,
      }
    );

    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(JSON.stringify(payload));
    }

    modelCache.openai.raw = payload;
    modelCache.openai.models = extractOpenAIModels(payload);
    modelCache.openai.fetchedAt = Date.now();
    modelCache.openai.lastError = null;
  })()
    .catch((error) => {
      modelCache.openai.lastError = error instanceof Error ? error.message : 'Unknown error';
    })
    .finally(() => {
      modelCache.openai.refreshing = null;
    });

  await modelCache.openai.refreshing;
}

async function refreshAnthropicModelCache(accessTokenOverride?: string | null): Promise<void> {
  if (modelCache.anthropic.refreshing) {
    await modelCache.anthropic.refreshing;
    return;
  }

  modelCache.anthropic.refreshing = (async () => {
    const accessToken = accessTokenOverride || (await getValidAccessToken());
    const response = await fetch(ANTHROPIC_MODELS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_BETA,
      },
    });

    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(JSON.stringify(payload));
    }

    modelCache.anthropic.raw = payload;
    modelCache.anthropic.models = extractAnthropicModels(payload);
    modelCache.anthropic.fetchedAt = Date.now();
    modelCache.anthropic.lastError = null;
  })()
    .catch((error) => {
      modelCache.anthropic.lastError = error instanceof Error ? error.message : 'Unknown error';
    })
    .finally(() => {
      modelCache.anthropic.refreshing = null;
    });

  await modelCache.anthropic.refreshing;
}

async function refreshAllModelCaches(): Promise<void> {
  await Promise.allSettled([
    endpointConfig.openaiEnabled ? refreshOpenAIModelCache() : Promise.resolve(),
    endpointConfig.anthropicEnabled ? refreshAnthropicModelCache() : Promise.resolve(),
  ]);
}

app.use(express.json({ limit: '50mb' }));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'code-router' });
});

app.get('/v1/models', async (req: Request, res: Response) => {
  try {
    const requestId = Math.random().toString(36).substring(7);
    const externalProvider =
      normalizeExternalProvider(toStringHeader(req.headers['x-code-router-provider'])) ||
      normalizeExternalProvider(toStringHeader(req.headers['x-router-provider'])) ||
      normalizeExternalProvider(toStringHeader(req.headers['provider'])) ||
      normalizeExternalProvider(typeof req.query.provider === 'string' ? req.query.provider : null);
    const provider = externalProvider === 'openrouter' ? null : externalProvider;

    if (!externalProvider) {
      if (modelCache.openai.models.length === 0 || modelCache.anthropic.models.length === 0) {
        await refreshAllModelCaches();
      }

      const combinedModels = normalizeCombinedModelList();
      res.json({
        object: 'list',
        data: combinedModels,
        models: combinedModels,
      });
      return;
    }

    if (externalProvider === 'openrouter') {
      if (modelCache.openai.models.length === 0 || modelCache.anthropic.models.length === 0) {
        await refreshAllModelCaches();
      }

      const openRouterModels = normalizeOpenRouterModelList();
      res.json({
        object: 'list',
        data: openRouterModels,
        models: openRouterModels,
      });
      return;
    }

    if (provider === 'openai') {
      if (modelCache.openai.raw) {
        res.json(modelCache.openai.raw);
        return;
      }

      const authorization = await getOpenAIAuthorization(req);
      if (!authorization) {
        res.status(401).json({
          error: {
            message: 'Missing OpenAI auth. Provide Authorization: Bearer sk-* or x-api-key.',
            type: 'authentication_error',
            param: null,
            code: null,
          },
        } satisfies OpenAIErrorResponse);
        return;
      }

      await refreshOpenAIModelCache(authorization);
      if (modelCache.openai.raw) {
        res.json(modelCache.openai.raw);
        return;
      }

      const queryString = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      const modelsUrl = `${OPENAI_MODELS_URL}${queryString}`;
      const openaiModelsHeaders = buildOpenAIRequestHeaders(authorization, requestId, false);
      logOutgoingRequest('openai', 'GET', modelsUrl, openaiModelsHeaders);

      const response = await fetch(modelsUrl, {
        method: 'GET',
        headers: openaiModelsHeaders,
      });

      const data = await response.json();
      res.status(response.status).json(data);
      return;
    }

    if (modelCache.anthropic.raw) {
      res.json(modelCache.anthropic.raw);
      return;
    }

    const clientBearerToken = extractBearerToken(req);
    const usePassthrough =
      endpointConfig.allowBearerPassthrough &&
      clientBearerToken !== null &&
      !isOpenAIKey(clientBearerToken);
    const accessToken = usePassthrough ? clientBearerToken! : await getValidAccessToken();

    await refreshAnthropicModelCache(accessToken);
    if (modelCache.anthropic.raw) {
      res.json(modelCache.anthropic.raw);
      return;
    }

    const anthropicModelsHeaders = {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ANTHROPIC_BETA,
    };
    logOutgoingRequest('anthropic', 'GET', ANTHROPIC_MODELS_URL, anthropicModelsHeaders);

    const response = await fetch(ANTHROPIC_MODELS_URL, {
      method: 'GET',
      headers: anthropicModelsHeaders,
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({
      type: 'error',
      error: {
        type: 'internal_error',
        message: error instanceof Error ? error.message : 'Failed to fetch models',
      },
    });
  }
});

const handleMessagesRequest = async (req: Request, res: Response) => {
  const requestId = Math.random().toString(36).substring(7);
  const timestamp = new Date().toISOString();

  try {
    const originalRequest = stripUnknownFields(req.body as Record<string, unknown>) as AnthropicRequest;
    const apiMode = resolveApiMode(req, { model: originalRequest.model });
    const normalizedRequest =
      normalizeRequestedModelName(originalRequest.model) === originalRequest.model
        ? originalRequest
        : { ...originalRequest, model: normalizeRequestedModelName(originalRequest.model) };
    const routedSelection = resolveProviderAndModel(req, normalizedRequest.model, {
      model: normalizedRequest.model,
    });
    const routedRequest =
      routedSelection.model === normalizedRequest.model
        ? normalizedRequest
        : { ...normalizedRequest, model: routedSelection.model };
    logRoutingDecision(req, normalizedRequest.model, routedSelection.provider, routedSelection.model);
    const hadSystemPrompt = !!(routedRequest.system && routedRequest.system.length > 0);
    const provider = routedSelection.provider;

    if (provider === 'openai') {
      const openaiRequest = translateAnthropicToOpenAIRequest(routedRequest);
      const authorization = await getOpenAIAuthorization(req);
      if (!authorization) {
        res.status(401).json({
          error: {
            message: 'Missing OpenAI auth. Provide Authorization: Bearer sk-* or x-api-key.',
            type: 'authentication_error',
            param: null,
            code: null,
          },
        } satisfies OpenAIErrorResponse);
        return;
      }

      const openaiMessagesHeaders = buildOpenAIRequestHeaders(authorization, requestId);
      const codexRequest = convertChatCompletionsToResponsesRequest(openaiRequest);
      logOutgoingRequest('openai', 'POST', OPENAI_RESPONSES_URL, openaiMessagesHeaders, codexRequest);

      const response = await fetch(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: openaiMessagesHeaders,
        body: JSON.stringify(codexRequest),
      });

      if (openaiRequest.stream && response.headers.get('content-type')?.includes('text/event-stream')) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.status(response.status);

        const messageId = `chatcmpl-${requestId}`;
        const codexStream = translateCodexResponsesStreamToChatCompletions(
          response.body as AsyncIterable<Uint8Array>,
          formatModelForApiMode(openaiRequest.model, apiMode),
          messageId
        );
        const translatedStream = translateOpenAIStreamToAnthropic(
          encodeStringStream(codexStream),
          formatModelForApiMode(openaiRequest.model, apiMode),
          messageId
        );

        await streamResponse(res, translatedStream);

        logger.logRequest(
          requestId,
          timestamp,
          routedRequest,
          hadSystemPrompt,
          { status: response.status, data: undefined },
          undefined,
          'openai'
        );
        return;
      }

      if (!response.ok) {
        const errorText = await response.text();
        logger.info(`  ChatGPT request body: ${JSON.stringify(codexRequest)}`);
        logger.info(`  ChatGPT response body: ${errorText}`);
        const errorData = {
          error: {
            message: errorText || `ChatGPT backend error (${response.status})`,
            type: 'invalid_request_error',
            param: null,
            code: null,
          },
        } satisfies OpenAIErrorResponse;
        const anthropicError = translateOpenAIErrorToAnthropic(errorData);
        logger.logRequest(
          requestId,
          timestamp,
          routedRequest,
          hadSystemPrompt,
          { status: response.status, data: undefined },
          undefined,
          'openai'
        );
        res.status(response.status).json(anthropicError);
        return;
      }

      const openaiResponse = await readCodexResponsesAsChatCompletion(
        response.body as AsyncIterable<Uint8Array>,
        formatModelForApiMode(openaiRequest.model, apiMode)
      );
      const anthropicResponse = translateOpenAIToAnthropicResponse(
        openaiResponse,
        formatModelForApiMode(routedRequest.model, apiMode)
      );
      logger.logRequest(
        requestId,
        timestamp,
        routedRequest,
        hadSystemPrompt,
        { status: response.status, data: anthropicResponse },
        undefined,
        'openai'
      );
      res.status(response.status).json(anthropicResponse);
      return;
    }

    const modifiedRequest = ensureRequiredSystemPrompt(routedRequest);

    const clientBearerToken = extractBearerToken(req);
    const usePassthrough =
      endpointConfig.allowBearerPassthrough &&
      clientBearerToken !== null &&
      !isOpenAIKey(clientBearerToken);
    const accessToken = usePassthrough ? clientBearerToken! : await getValidAccessToken();

    const anthropicMessagesHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ANTHROPIC_BETA,
    };
    logOutgoingRequest(
      'anthropic',
      'POST',
      ANTHROPIC_API_URL,
      anthropicMessagesHeaders,
      modifiedRequest
    );

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: anthropicMessagesHeaders,
      body: JSON.stringify(modifiedRequest),
    });

    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.status(response.status);
      await streamResponse(res, response.body as AsyncIterable<Uint8Array>);
      logger.logRequest(requestId, timestamp, originalRequest, hadSystemPrompt, {
        status: response.status,
        data: undefined,
      });
      return;
    }

    const responseData = (await response.json()) as AnthropicResponse;
    const formattedResponseData =
      apiMode === 'openrouter'
        ? { ...responseData, model: formatModelForApiMode(responseData.model, apiMode) }
        : responseData;
    logger.logRequest(requestId, timestamp, originalRequest, hadSystemPrompt, {
      status: response.status,
      data: formattedResponseData,
    });
    res.status(response.status).json(formattedResponseData);
  } catch (error) {
    logger.logRequest(
      requestId,
      timestamp,
      req.body as AnthropicRequest,
      false,
      undefined,
      error instanceof Error ? error : new Error('Unknown error')
    );

    if (res.headersSent) {
      logger.error(`[${requestId}] Error after headers sent`, error);
      return;
    }

    res.status(500).json({
      error: {
        type: 'internal_error',
        message: error instanceof Error ? error.message : 'An unexpected error occurred',
      },
    });
  }
};

const handleChatCompletionsRequest = async (req: Request, res: Response) => {
  const requestId = Math.random().toString(36).substring(7);
  const timestamp = new Date().toISOString();

  try {
    const rawOpenAIRequest = req.body as OpenAIChatCompletionRequest;
    const apiMode = resolveApiMode(req, rawOpenAIRequest);
    const openaiRequest =
      normalizeRequestedModelName(rawOpenAIRequest.model) === rawOpenAIRequest.model
        ? rawOpenAIRequest
        : { ...rawOpenAIRequest, model: normalizeRequestedModelName(rawOpenAIRequest.model) };
    validateOpenAIRequest(openaiRequest);

    const routedSelection = resolveProviderAndModel(req, openaiRequest.model, openaiRequest);
    const routedOpenAIRequest =
      routedSelection.model === openaiRequest.model
        ? openaiRequest
        : { ...openaiRequest, model: routedSelection.model };
    logRoutingDecision(req, openaiRequest.model, routedSelection.provider, routedSelection.model);
    const provider = routedSelection.provider;
    if (provider === 'anthropic') {
      const anthropicRequest = translateOpenAIToAnthropic(routedOpenAIRequest);
      const hadSystemPrompt = !!(anthropicRequest.system && anthropicRequest.system.length > 0);
      const modifiedRequest = ensureRequiredSystemPrompt(anthropicRequest);
      const clientBearerToken = extractBearerToken(req);
      const usePassthrough =
        endpointConfig.allowBearerPassthrough &&
        clientBearerToken !== null &&
        !isOpenAIKey(clientBearerToken);
      const accessToken = usePassthrough ? clientBearerToken! : await getValidAccessToken();

      const chatAnthropicHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_BETA,
      };
      logOutgoingRequest('anthropic', 'POST', ANTHROPIC_API_URL, chatAnthropicHeaders, modifiedRequest);

      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: chatAnthropicHeaders,
        body: JSON.stringify(modifiedRequest),
      });

      if (
        routedOpenAIRequest.stream &&
        response.headers.get('content-type')?.includes('text/event-stream')
      ) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.status(response.status);

        const messageId = `chatcmpl-${requestId}`;
        const translatedStream = translateAnthropicStreamToOpenAI(
          response.body as AsyncIterable<Uint8Array>,
          formatModelForApiMode(routedOpenAIRequest.model, apiMode),
          messageId
        );

        await streamResponse(res, translatedStream);

        logger.logRequest(
          requestId,
          timestamp,
          modifiedRequest,
          hadSystemPrompt,
          { status: response.status, data: undefined },
          undefined,
          'openai'
        );
        return;
      }

      if (!response.ok) {
        const errorData = await response.json();
        const openaiError = translateAnthropicErrorToOpenAI(errorData);
        logger.logRequest(
          requestId,
          timestamp,
          modifiedRequest,
          hadSystemPrompt,
          { status: response.status, data: errorData as AnthropicResponse },
          undefined,
          'openai'
        );
        res.status(response.status).json(openaiError);
        return;
      }

      const anthropicResponse = (await response.json()) as AnthropicResponse;
      const openaiResponse = translateAnthropicToOpenAI(
        anthropicResponse,
        formatModelForApiMode(routedOpenAIRequest.model, apiMode)
      );
      logger.logRequest(
        requestId,
        timestamp,
        modifiedRequest,
        hadSystemPrompt,
        { status: response.status, data: anthropicResponse },
        undefined,
        'openai'
      );
      res.status(response.status).json(openaiResponse);
      return;
    }

    const authorization = await getOpenAIAuthorization(req);
    if (!authorization) {
      res.status(401).json({
        error: {
          message: 'Missing OpenAI auth. Provide Authorization: Bearer sk-* or x-api-key.',
          type: 'authentication_error',
          param: null,
          code: null,
        },
      } satisfies OpenAIErrorResponse);
      return;
    }

    const openaiResponsesRequest = convertChatCompletionsToResponsesRequest(routedOpenAIRequest);
    const openaiChatHeaders = buildOpenAIRequestHeaders(authorization, requestId);
    logOutgoingRequest('openai', 'POST', OPENAI_RESPONSES_URL, openaiChatHeaders, openaiResponsesRequest);

    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: openaiChatHeaders,
      body: JSON.stringify(openaiResponsesRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const openaiError = {
        error: {
          message: errorText || `ChatGPT backend error (${response.status})`,
          type: 'invalid_request_error',
          param: null,
          code: null,
        },
      } satisfies OpenAIErrorResponse;
      logger.logRequest(
        requestId,
        timestamp,
        req.body as AnthropicRequest,
        false,
        undefined,
        new Error(openaiError.error.message),
        'openai'
      );
      res.status(response.status).json(openaiError);
      return;
    }

    if (routedOpenAIRequest.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.status(response.status);
      const messageId = `chatcmpl-${requestId}`;
      const translatedStream = translateCodexResponsesStreamToChatCompletions(
        response.body as AsyncIterable<Uint8Array>,
        formatModelForApiMode(routedOpenAIRequest.model, apiMode),
        messageId
      );
      await streamResponse(res, translatedStream);
      logger.logRequest(
        requestId,
        timestamp,
        req.body as AnthropicRequest,
        false,
        { status: response.status, data: undefined },
        undefined,
        'openai'
      );
      return;
    }

    const responseData = await readCodexResponsesAsChatCompletion(
      response.body as AsyncIterable<Uint8Array>,
      routedOpenAIRequest.model
    );
    logger.logRequest(
      requestId,
      timestamp,
      req.body as AnthropicRequest,
      false,
      { status: response.status, data: responseData as unknown as AnthropicResponse },
      undefined,
      'openai'
    );
    res.status(response.status).json(responseData);
  } catch (error) {
    logger.logRequest(
      requestId,
      timestamp,
      req.body as AnthropicRequest,
      false,
      undefined,
      error instanceof Error ? error : new Error('Unknown error'),
      'openai'
    );

    if (res.headersSent) {
      logger.error(`[${requestId}] Error after headers sent:`, error);
      return;
    }

    res.status(500).json(
      {
        error: {
          message: error instanceof Error ? error.message : 'An unexpected error occurred',
          type: 'internal_error',
          param: null,
          code: null,
        },
      } satisfies OpenAIErrorResponse
    );
  }
};

const handleResponsesRequest = async (req: Request, res: Response) => {
  const requestId = Math.random().toString(36).substring(7);
  const timestamp = new Date().toISOString();

  try {
    const responsesRequest = req.body as OpenAIResponsesRequest;
    const openaiRequest = convertResponsesToOpenAIChatRequest(responsesRequest);
    const apiMode = resolveApiMode(req, { model: openaiRequest.model });
    const normalizedOpenAIRequest =
      normalizeRequestedModelName(openaiRequest.model) === openaiRequest.model
        ? openaiRequest
        : { ...openaiRequest, model: normalizeRequestedModelName(openaiRequest.model) };
    if (normalizedOpenAIRequest.messages.length === 0) {
      res.status(400).json({
        error: {
          message: 'OpenAI Responses-style request requires at least one input message.',
          type: 'invalid_request_error',
          param: 'input',
          code: null,
        },
      } satisfies OpenAIErrorResponse);
      return;
    }

    const routedSelection = resolveProviderAndModel(
      req,
      normalizedOpenAIRequest.model,
      normalizedOpenAIRequest
    );
    const routedOpenAIRequest =
      routedSelection.model === normalizedOpenAIRequest.model
        ? normalizedOpenAIRequest
        : { ...normalizedOpenAIRequest, model: routedSelection.model };
    logRoutingDecision(
      req,
      normalizedOpenAIRequest.model,
      routedSelection.provider,
      routedSelection.model
    );

    if (routedSelection.provider === 'openai') {
      const authorization = await getOpenAIAuthorization(req);
      if (!authorization) {
        res.status(401).json({
          error: {
            message: 'Missing OpenAI auth. Provide Authorization: Bearer sk-* or x-api-key.',
            type: 'authentication_error',
            param: null,
            code: null,
          },
        } satisfies OpenAIErrorResponse);
        return;
      }

      const codexRequest = convertChatCompletionsToResponsesRequest(routedOpenAIRequest);
      const openaiHeaders = buildOpenAIRequestHeaders(authorization, requestId);
      logOutgoingRequest('openai', 'POST', OPENAI_RESPONSES_URL, openaiHeaders, codexRequest);

      const response = await fetch(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: openaiHeaders,
        body: JSON.stringify(codexRequest),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.info(`  ChatGPT request body: ${JSON.stringify(codexRequest)}`);
        logger.info(`  ChatGPT response body: ${errorText}`);
        res.status(response.status).json({
          error: {
            message: errorText || `ChatGPT backend error (${response.status})`,
            type: 'invalid_request_error',
            param: null,
            code: null,
          },
        } satisfies OpenAIErrorResponse);
        return;
      }

      if (routedOpenAIRequest.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.status(response.status);

        const messageId = `chatcmpl-${requestId}`;
        const translatedStream = translateCodexResponsesStreamToChatCompletions(
          response.body as AsyncIterable<Uint8Array>,
          routedOpenAIRequest.model,
          messageId
        );
        await streamResponse(res, translatedStream);
        return;
      }

      const responseData = await readCodexResponsesAsChatCompletion(
        response.body as AsyncIterable<Uint8Array>,
        formatModelForApiMode(routedOpenAIRequest.model, apiMode)
      );
      res.status(response.status).json(responseData);
      return;
    }

    const anthropicRequest = translateOpenAIToAnthropic(routedOpenAIRequest);
    const hadSystemPrompt = !!(anthropicRequest.system && anthropicRequest.system.length > 0);
    const modifiedRequest = ensureRequiredSystemPrompt(anthropicRequest);
    const clientBearerToken = extractBearerToken(req);
    const usePassthrough =
      endpointConfig.allowBearerPassthrough &&
      clientBearerToken !== null &&
      !isOpenAIKey(clientBearerToken);
    const accessToken = usePassthrough ? clientBearerToken! : await getValidAccessToken();

    const chatAnthropicHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ANTHROPIC_BETA,
    };
    logOutgoingRequest('anthropic', 'POST', ANTHROPIC_API_URL, chatAnthropicHeaders, modifiedRequest);

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: chatAnthropicHeaders,
      body: JSON.stringify(modifiedRequest),
    });

    if (
      routedOpenAIRequest.stream &&
      response.headers.get('content-type')?.includes('text/event-stream')
    ) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.status(response.status);

      const messageId = `chatcmpl-${requestId}`;
      const translatedStream = translateAnthropicStreamToOpenAI(
        response.body as AsyncIterable<Uint8Array>,
        formatModelForApiMode(routedOpenAIRequest.model, apiMode),
        messageId
      );
      await streamResponse(res, translatedStream);
      logger.logRequest(
        requestId,
        timestamp,
        modifiedRequest,
        hadSystemPrompt,
        { status: response.status, data: undefined },
        undefined,
        'anthropic'
      );
      return;
    }

    const responseData = (await response.json()) as AnthropicResponse | OpenAIErrorResponse;
    if (!response.ok) {
      const openaiError = translateAnthropicErrorToOpenAI(responseData);
      logger.logRequest(
        requestId,
        timestamp,
        modifiedRequest,
        hadSystemPrompt,
        { status: response.status, data: responseData as AnthropicResponse },
        undefined,
        'anthropic'
      );
      res.status(response.status).json(openaiError);
      return;
    }

    const openaiResponse = translateAnthropicToOpenAI(
      responseData as AnthropicResponse,
      formatModelForApiMode(routedOpenAIRequest.model, apiMode)
    );
    logger.logRequest(
      requestId,
      timestamp,
      modifiedRequest,
      hadSystemPrompt,
      { status: response.status, data: responseData as AnthropicResponse },
      undefined,
      'anthropic'
    );
    res.status(response.status).json(openaiResponse);
  } catch (error) {
    logger.logRequest(
      requestId,
      timestamp,
      {
        model: 'openai/responses',
        max_tokens: 0,
        messages: [],
      } as unknown as AnthropicRequest,
      false,
      undefined,
      error instanceof Error ? error : new Error('Unknown error'),
      'anthropic'
    );

    if (res.headersSent) {
      logger.error(`[${requestId}] Error after headers sent`, error);
      return;
    }

    res.status(500).json({
      error: {
        message: error instanceof Error ? error.message : 'An unexpected error occurred',
        type: 'internal_error',
        param: null,
        code: null,
      },
    } satisfies OpenAIErrorResponse);
  }
};

if (endpointConfig.anthropicEnabled || endpointConfig.openaiEnabled) {
  app.post('/v1/messages', handleMessagesRequest);
  app.post('/v1/v1/messages', handleMessagesRequest);
}

if (endpointConfig.anthropicEnabled || endpointConfig.openaiEnabled) {
  app.post('/v1/chat/completions', handleChatCompletionsRequest);
  app.post('/v1/responses', handleResponsesRequest);
}

async function startRouter() {
  await hydrateOpenAIAuthState();

  logger.startup('');
  logger.startup('██████╗ ██████╗ ██████╗ ███████╗');
  logger.startup('██╔════╝██╔═══██╗██╔══██╗██╔════╝');
  logger.startup('██║     ██║   ██║██║  ██║█████╗  ');
  logger.startup('██║     ██║   ██║██║  ██║██╔══╝  ');
  logger.startup('╚██████╗╚██████╔╝██████╔╝███████╗');
  logger.startup(' ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝');
  logger.startup('');
  logger.startup('██████╗  ██████╗ ██╗   ██╗████████╗███████╗██████╗ ');
  logger.startup('██╔══██╗██╔═══██╗██║   ██║╚══██╔══╝██╔════╝██╔══██╗');
  logger.startup('██████╔╝██║   ██║██║   ██║   ██║   █████╗  ██████╔╝');
  logger.startup('██╔══██╗██║   ██║██║   ██║   ██║   ██╔══╝  ██╔══██╗');
  logger.startup('██║  ██║╚██████╔╝╚██████╔╝   ██║   ███████╗██║  ██║');
  logger.startup('╚═╝  ╚═╝ ╚═════╝  ╚═════╝    ╚═╝   ╚══════╝╚═╝  ╚═╝');
  logger.startup('');

  let tokens = await loadTokens();
  if (!tokens && !endpointConfig.allowBearerPassthrough) {
    logger.startup('No OAuth tokens found. Starting authentication...');
    try {
      const { code, verifier, state } = await startOAuthFlow(askQuestion);
      logger.startup('✅ Authorization received');
      logger.startup('🔄 Exchanging for tokens...');
      const newTokens = await exchangeCodeForTokens(code, verifier, state);
      await saveTokens(newTokens);
      tokens = newTokens;
      logger.startup('✅ Authentication successful!');
    } catch (error) {
      logger.error('❌ Authentication failed:', error instanceof Error ? error.message : error);
      rl.close();
      process.exit(1);
    }
  } else if (tokens) {
    try {
      await getValidAccessToken();
      logger.startup('✅ Token validated.');
    } catch (error) {
      logger.error('❌ Token validation failed:', error);
      rl.close();
      process.exit(1);
    }
  } else if (endpointConfig.allowBearerPassthrough) {
    logger.startup('⚠️  No OAuth tokens - bearer passthrough mode only');
  }

  const hasAnthropicOAuthToken = Boolean(tokens?.access_token);
  anthropicAuthConfigured = hasAnthropicOAuthToken;
  const anthropicAvailability = !endpointConfig.anthropicEnabled
    ? 'disabled'
    : hasAnthropicOAuthToken
      ? 'available'
      : 'not available';
  const anthropicAvailabilityDetails = !endpointConfig.anthropicEnabled
    ? 'disabled via router flag'
    : hasAnthropicOAuthToken
      ? 'router OAuth token'
      : 'missing OAuth token';

  rl.close();
  logger.startup('');

  app.listen(PORT, () => {
    void refreshAllModelCaches();
    setInterval(() => {
      void refreshAllModelCaches();
    }, MODEL_CACHE_REFRESH_MS);

    logger.startup(`🚀 Router running on http://localhost:${PORT}`);
    logger.startup('');
    logger.startup('📋 Endpoints:');
    if (endpointConfig.anthropicEnabled || endpointConfig.openaiEnabled) {
      logger.startup(`   POST http://localhost:${PORT}/v1/messages`);
      logger.startup(`   POST http://localhost:${PORT}/v1/chat/completions`);
      logger.startup(`   POST http://localhost:${PORT}/v1/responses`);
    }
    logger.startup(`   GET  http://localhost:${PORT}/v1/models`);
    logger.startup(`   GET  http://localhost:${PORT}/health`);
    logger.startup('');
    logger.startup('🧾 Runtime status:');
    logger.startup(
      `   Default provider: ${
        normalizeProvider(process.env.CODE_ROUTER_DEFAULT_CHAT_PROVIDER) ||
        normalizeProvider(process.env.ROUTER_DEFAULT_PROVIDER) ||
        'auto (anthropic fallback)'
      }`
    );
    logger.startup(
      `   Anthropic: ${anthropicAvailability} (${anthropicAvailabilityDetails})`
    );
    logger.startup(
      `   OpenAI auth: ${openAIAuth.sourceConfigured ? 'configured' : 'missing'} (env key or saved key)`
    );
    logger.startup('');
  });
}

startRouter().catch((error) => {
  logger.error('Failed to start router:', error);
  process.exit(1);
});
