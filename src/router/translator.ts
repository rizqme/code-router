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

import {
  OpenAIChatCompletionRequest,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAITool,
  OpenAIChatCompletionResponse,
  OpenAIErrorResponse,
  OpenAIMessage as OpenAIMessageType,
  AnthropicRequest,
  AnthropicResponse,
  Message,
  Tool,
  ContentBlock,
} from '../types.js';
import { mapOpenAIModelToAnthropic } from './model-mapper.js';
import { mapAnthropicModelToOpenAI } from './model-mapper.js';

function extractTextFromOpenAIContent(content: OpenAIMessage['content']): string {
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
}

function openAIImagePartToAnthropicBlock(part: OpenAIContentPart): ContentBlock | null {
  if (part.type !== 'image_url' || typeof part.image_url?.url !== 'string') {
    return null;
  }

  const imageUrl = part.image_url.url.trim();
  if (imageUrl.length === 0) {
    return null;
  }

  const dataUriMatch = imageUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (dataUriMatch) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: dataUriMatch[1],
        data: dataUriMatch[2],
      },
    } as ContentBlock;
  }

  return {
    type: 'image',
    source: {
      type: 'url',
      url: imageUrl,
    },
  } as ContentBlock;
}

function translateOpenAIContentToAnthropicBlocks(
  content: OpenAIMessage['content']
): ContentBlock[] {
  if (typeof content === 'string') {
    const trimmedContent = content.trim();
    return trimmedContent.length > 0 ? [{ type: 'text', text: trimmedContent }] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part) => {
    if (part.type === 'text') {
      const trimmedText = part.text.trim();
      return trimmedText.length > 0 ? [{ type: 'text', text: trimmedText }] : [];
    }

    const imageBlock = openAIImagePartToAnthropicBlock(part);
    return imageBlock ? [imageBlock] : [];
  });
}

function anthropicImageBlockToOpenAIContentPart(
  block: Record<string, unknown>
): OpenAIContentPart | null {
  const source =
    block.source && typeof block.source === 'object'
      ? (block.source as Record<string, unknown>)
      : null;
  if (!source || typeof source.type !== 'string') {
    return null;
  }

  if (source.type === 'url' && typeof source.url === 'string' && source.url.trim().length > 0) {
    return {
      type: 'image_url',
      image_url: {
        url: source.url.trim(),
      },
    };
  }

  if (
    source.type === 'base64' &&
    typeof source.data === 'string' &&
    typeof source.media_type === 'string' &&
    source.data.trim().length > 0
  ) {
    return {
      type: 'image_url',
      image_url: {
        url: `data:${source.media_type};base64,${source.data}`,
      },
    };
  }

  return null;
}

function translateAnthropicBlocksToOpenAIContent(
  blocks: ContentBlock[]
): OpenAIMessageType['content'] {
  const contentParts: OpenAIContentPart[] = [];
  const toolMarkers: string[] = [];

  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      contentParts.push({
        type: 'text',
        text: block.text,
      });
      continue;
    }

    if (block.type === 'image') {
      const imagePart = anthropicImageBlockToOpenAIContentPart(block as Record<string, unknown>);
      if (imagePart) {
        contentParts.push(imagePart);
      }
      continue;
    }

    if (block.type === 'tool_use') {
      toolMarkers.push(`[tool_use:${String(block.id ?? 'unknown')}]`);
      continue;
    }

    if (block.type === 'tool_result') {
      toolMarkers.push(`[tool_result:${String(block.tool_use_id ?? block.id ?? 'unknown')}]`);
    }
  }

  if (toolMarkers.length > 0) {
    contentParts.push({
      type: 'text',
      text: toolMarkers.join('\n\n'),
    });
  }

  if (contentParts.length === 0) {
    return null;
  }

  if (contentParts.every((part) => part.type === 'text')) {
    return contentParts.map((part) => part.text).join('\n\n');
  }

  return contentParts;
}

/**
 * Translate OpenAI Chat Completion request to Anthropic Messages API request
 */
export function translateOpenAIToAnthropic(
  openaiRequest: OpenAIChatCompletionRequest
): AnthropicRequest {
  const systemMessages: string[] = [];
  const anthropicMessages: Message[] = [];

  const appendAnthropicMessage = (
    role: 'user' | 'assistant',
    content: string | ContentBlock[]
  ): void => {
    const normalizedContent =
      typeof content === 'string'
        ? content.trim()
        : content.filter((block) => {
            if (block.type === 'text') {
              return typeof block.text === 'string' && block.text.trim().length > 0;
            }
            return true;
          });

    if (
      (typeof normalizedContent === 'string' && normalizedContent.length === 0) ||
      (Array.isArray(normalizedContent) && normalizedContent.length === 0)
    ) {
      return;
    }

    const previousMessage = anthropicMessages[anthropicMessages.length - 1];
    if (!previousMessage || previousMessage.role !== role) {
      anthropicMessages.push({ role, content: normalizedContent });
      return;
    }

    if (typeof previousMessage.content === 'string' && typeof normalizedContent === 'string') {
      previousMessage.content = `${previousMessage.content}\n\n${normalizedContent}`;
      return;
    }

    const previousBlocks =
      typeof previousMessage.content === 'string'
        ? [{ type: 'text', text: previousMessage.content } satisfies ContentBlock]
        : previousMessage.content;
    const nextBlocks =
      typeof normalizedContent === 'string'
        ? [{ type: 'text', text: normalizedContent } satisfies ContentBlock]
        : normalizedContent;
    previousMessage.content = [...previousBlocks, ...nextBlocks];
  };

  for (const msg of openaiRequest.messages) {
    if (msg.role === 'system') {
      const systemText = extractTextFromOpenAIContent(msg.content).trim();
      if (systemText.length > 0) {
        systemMessages.push(systemText);
      }
      continue;
    }

    if (msg.role === 'tool') {
      const toolResultText = extractTextFromOpenAIContent(msg.content).trim();
      appendAnthropicMessage('user', [
        {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id || 'unknown',
          content: toolResultText.length > 0 ? toolResultText : '[empty tool result]',
        } as ContentBlock,
      ]);
      continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const contentBlocks: ContentBlock[] = [];
      contentBlocks.push(...translateOpenAIContentToAnthropicBlocks(msg.content));

      for (const toolCall of msg.tool_calls) {
        let parsedArguments: Record<string, unknown> = {};
        try {
          parsedArguments = toolCall.function.arguments
            ? (JSON.parse(toolCall.function.arguments) as Record<string, unknown>)
            : {};
        } catch {
          parsedArguments = { raw: toolCall.function.arguments };
        }

        contentBlocks.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: parsedArguments,
        } as ContentBlock);
      }

      appendAnthropicMessage('assistant', contentBlocks);
      continue;
    }

    const contentBlocks = translateOpenAIContentToAnthropicBlocks(msg.content);
    if (contentBlocks.length > 0) {
      appendAnthropicMessage(
        msg.role as 'user' | 'assistant',
        contentBlocks.length === 1 && contentBlocks[0].type === 'text'
          ? String(contentBlocks[0].text)
          : contentBlocks
      );
    }
  }

  let anthropicTools: Tool[] | undefined;
  if (openaiRequest.tools && openaiRequest.tools.length > 0) {
    anthropicTools = openaiRequest.tools.map(translateOpenAIToolToAnthropic);
  }

  const anthropicRequest: AnthropicRequest = {
    model: mapOpenAIModelToAnthropic(openaiRequest.model),
    max_tokens: openaiRequest.max_tokens || 4096,
    messages: anthropicMessages,
    stream: openaiRequest.stream || false,
  };

  // Add system messages if present
  if (systemMessages.length > 0) {
    anthropicRequest.system = [
      {
        type: 'text',
        text: systemMessages.join('\n\n'),
      },
    ];
  }

  if (anthropicTools && anthropicTools.length > 0) {
    anthropicRequest.tools = anthropicTools;
  }

  if (openaiRequest.tool_choice) {
    if (openaiRequest.tool_choice === 'auto') {
      anthropicRequest.tool_choice = { type: 'auto' };
    } else if (openaiRequest.tool_choice === 'none') {
      anthropicRequest.tool_choice = { type: 'auto' };
    } else if (openaiRequest.tool_choice.type === 'function') {
      anthropicRequest.tool_choice = {
        type: 'tool',
        name: openaiRequest.tool_choice.function.name,
      };
    }
  }

  return anthropicRequest;
}

/**
 * Translate Anthropic Messages request to OpenAI Chat Completion request
 */
export function translateAnthropicToOpenAIRequest(
  anthropicRequest: AnthropicRequest
): OpenAIChatCompletionRequest {
  const messages: OpenAIMessageType[] = [];

  if (anthropicRequest.system && anthropicRequest.system.length > 0) {
    messages.push({
      role: 'system',
      content: anthropicRequest.system.map((entry) => entry.text).join('\n\n'),
    });
  }

  for (const message of anthropicRequest.messages) {
    if (typeof message.content === 'string') {
      messages.push({
        role: message.role,
        content: message.content,
      });
      continue;
    }

    const translatedContent = translateAnthropicBlocksToOpenAIContent(message.content);
    if (translatedContent !== null) {
      messages.push({
        role: message.role,
        content: translatedContent,
      });
    }
  }

  const openaiTools = anthropicRequest.tools?.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));

  let toolChoice: OpenAIChatCompletionRequest['tool_choice'];
  if (anthropicRequest.tool_choice) {
    if (anthropicRequest.tool_choice.type === 'tool') {
      toolChoice = anthropicRequest.tool_choice.name
        ? { type: 'function', function: { name: anthropicRequest.tool_choice.name } }
        : 'auto';
    } else {
      toolChoice = anthropicRequest.tool_choice.type === 'any' ? 'auto' : 'auto';
    }
  }

  return {
    model: mapAnthropicModelToOpenAI(anthropicRequest.model),
    messages,
    temperature: undefined,
    top_p: undefined,
    n: 1,
    stream: anthropicRequest.stream || false,
    stop: undefined,
    max_tokens: anthropicRequest.max_tokens,
    user: undefined,
    tools: openaiTools,
    tool_choice: toolChoice,
  };
}

/**
 * Translate OpenAI tool to Anthropic tool
 */
function translateOpenAIToolToAnthropic(openaiTool: OpenAITool): Tool {
  return {
    name: openaiTool.function.name,
    description: openaiTool.function.description,
    input_schema: {
      type: 'object',
      properties: openaiTool.function.parameters.properties,
      required: openaiTool.function.parameters.required,
    },
  };
}

/**
 * Translate Anthropic response to OpenAI Chat Completion response
 */
export function translateAnthropicToOpenAI(
  anthropicResponse: AnthropicResponse,
  originalModel: string
): OpenAIChatCompletionResponse {
  // Extract text content from Anthropic's content blocks
  const textBlocks = anthropicResponse.content.filter(
    (block: ContentBlock) => block.type === 'text'
  );
  const content = textBlocks.map((block: ContentBlock) => block.text).join('');

  // Map stop_reason to finish_reason
  let finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null = null;
  if (anthropicResponse.stop_reason === 'end_turn') {
    finishReason = 'stop';
  } else if (anthropicResponse.stop_reason === 'max_tokens') {
    finishReason = 'length';
  } else if (anthropicResponse.stop_reason === 'tool_use') {
    finishReason = 'tool_calls';
  }

  // Check if there are tool uses
  const toolUseBlocks = anthropicResponse.content.filter(
    (block: ContentBlock) => block.type === 'tool_use'
  );

  const toolCalls =
    toolUseBlocks.length > 0
      ? toolUseBlocks.map((block: ContentBlock) => ({
          id: block.id as string,
          type: 'function' as const,
          function: {
            name: block.name as string,
            arguments: JSON.stringify(block.input),
          },
        }))
      : undefined;

  return {
    id: anthropicResponse.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: originalModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || null,
          ...(toolCalls && { tool_calls: toolCalls }),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: anthropicResponse.usage.input_tokens,
      completion_tokens: anthropicResponse.usage.output_tokens,
      total_tokens: anthropicResponse.usage.input_tokens + anthropicResponse.usage.output_tokens,
    },
  };
}

/**
 * Translate OpenAI Chat Completion response to Anthropic Messages API response
 */
export function translateOpenAIToAnthropicResponse(
  openaiResponse: OpenAIChatCompletionResponse,
  originalModel: string
): AnthropicResponse {
  const firstChoice = openaiResponse.choices?.[0];
  const contentBlocks: ContentBlock[] = [];

  if (typeof firstChoice?.message?.content === 'string') {
    contentBlocks.push({
      type: 'text',
      text: firstChoice.message.content ?? '',
    });
  }

  if (firstChoice?.message?.tool_calls && firstChoice.message.tool_calls.length > 0) {
    for (const toolCall of firstChoice.message.tool_calls) {
      let parsedArguments: Record<string, unknown> = {};

      if (toolCall.function.arguments) {
        try {
          parsedArguments = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
        } catch {
          parsedArguments = { raw: toolCall.function.arguments };
        }
      }

      contentBlocks.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input: parsedArguments,
      } as ContentBlock);
    }
  }

  let stopReason: AnthropicResponse['stop_reason'] = null;
  if (firstChoice?.finish_reason === 'stop') {
    stopReason = 'end_turn';
  } else if (firstChoice?.finish_reason === 'length') {
    stopReason = 'max_tokens';
  } else if (firstChoice?.finish_reason === 'tool_calls') {
    stopReason = 'tool_use';
  } else if (firstChoice?.finish_reason === 'content_filter') {
    stopReason = 'stop_sequence';
  }

  return {
    id: openaiResponse.id,
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model: originalModel || openaiResponse.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

/**
 * Translate Anthropic streaming events to OpenAI streaming format
 * This returns a generator that yields OpenAI-formatted SSE strings
 */
export async function* translateAnthropicStreamToOpenAI(
  anthropicStream: AsyncIterable<Uint8Array>,
  originalModel: string,
  messageId: string
): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let sawToolCall = false;
  let nextToolCallIndex = 0;
  const toolBlocks = new Map<
    number,
    {
      id: string;
      name: string;
      arguments: string;
      emitted: boolean;
    }
  >();

  // Send initial chunk with role
  yield `data: ${JSON.stringify({
    id: messageId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: originalModel,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant' },
        finish_reason: null,
      },
    ],
  })}\n\n`;

  for await (const chunk of anthropicStream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim() || line.startsWith(':')) continue;

      if (line.startsWith('data: ')) {
        const data = line.slice(6);

        try {
          const event = JSON.parse(data);

          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            const index = typeof event.index === 'number' ? event.index : null;
            const toolUseId =
              event.content_block && typeof event.content_block.id === 'string'
                ? event.content_block.id
                : null;
            const toolName =
              event.content_block && typeof event.content_block.name === 'string'
                ? event.content_block.name
                : null;

            if (index !== null && toolUseId && toolName) {
              toolBlocks.set(index, {
                id: toolUseId,
                name: toolName,
                arguments: '',
                emitted: false,
              });
            }
          } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            yield `data: ${JSON.stringify({
              id: messageId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: originalModel,
              choices: [
                {
                  index: 0,
                  delta: { content: event.delta.text },
                  finish_reason: null,
                },
              ],
            })}\n\n`;
          } else if (
            event.type === 'content_block_delta' &&
            event.delta?.type === 'input_json_delta'
          ) {
            const index = typeof event.index === 'number' ? event.index : null;
            const partialJson =
              typeof event.delta.partial_json === 'string' ? event.delta.partial_json : null;

            if (index !== null && partialJson !== null) {
              const toolBlock = toolBlocks.get(index);
              if (toolBlock) {
                toolBlock.arguments += partialJson;
              }
            }
          } else if (event.type === 'content_block_stop') {
            const index = typeof event.index === 'number' ? event.index : null;
            const toolBlock = index !== null ? toolBlocks.get(index) : undefined;

            if (toolBlock && !toolBlock.emitted) {
              toolBlock.emitted = true;
              sawToolCall = true;
              yield `data: ${JSON.stringify({
                id: messageId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: originalModel,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: nextToolCallIndex++,
                          id: toolBlock.id,
                          type: 'function',
                          function: {
                            name: toolBlock.name,
                            arguments: toolBlock.arguments || '{}',
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              })}\n\n`;
            }
          } else if (event.type === 'message_delta' && event.usage) {
            totalOutputTokens = event.usage.output_tokens || totalOutputTokens;
          } else if (event.type === 'message_start' && event.message?.usage) {
            totalInputTokens = event.message.usage.input_tokens || 0;
          }
        } catch {
          // Ignore parse errors for streaming events
        }
      }
    }
  }

  // Send final chunk with usage information
  yield `data: ${JSON.stringify({
    id: messageId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: originalModel,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: sawToolCall ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: totalInputTokens,
      completion_tokens: totalOutputTokens,
      total_tokens: totalInputTokens + totalOutputTokens,
    },
  })}\n\n`;

  // Send [DONE] marker
  yield 'data: [DONE]\n\n';
}

/**
 * Translate OpenAI streaming responses to Anthropic SSE format
 */
export async function* translateOpenAIStreamToAnthropic(
  openaiStream: AsyncIterable<Uint8Array>,
  originalModel: string,
  messageId: string
): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  let sawFirstDelta = false;
  let outputTokens = 0;
  let inputTokens = 0;
  let finishReason: AnthropicResponse['stop_reason'] = null;

  const sendMessageStart = (): string => {
    return JSON.stringify({
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: originalModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
        },
      },
    });
  };

  const mapFinishReason = (reason: string | null): AnthropicResponse['stop_reason'] => {
    if (reason === 'length') {
      return 'max_tokens';
    }
    if (reason === 'tool_calls') {
      return 'tool_use';
    }
    if (reason === 'content_filter') {
      return 'stop_sequence';
    }
    if (reason === 'stop') {
      return 'end_turn';
    }
    return null;
  };

  yield `data: ${sendMessageStart()}\n\n`;

  for await (const chunk of openaiStream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim() || line.startsWith(':')) {
        continue;
      }

      if (!line.startsWith('data: ')) {
        continue;
      }

      const payload = line.slice(6);
      if (payload === '[DONE]') {
        continue;
      }

      try {
        const event = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              role?: 'assistant';
              content?: string;
            };
            finish_reason?: string | null;
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
        };

        if (event.usage) {
          inputTokens = event.usage.prompt_tokens ?? inputTokens;
          outputTokens = event.usage.completion_tokens ?? outputTokens;
        }

        const choice = event.choices?.[0];
        if (!choice) {
          continue;
        }

        if (choice.delta?.role === 'assistant' && !sawFirstDelta) {
          yield `data: ${JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'text',
              text: '',
            },
          })}\n\n`;
          sawFirstDelta = true;
        }

        if (choice.delta?.content) {
          yield `data: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'text_delta',
              text: choice.delta.content,
            },
          })}\n\n`;
        }

        if (choice.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason);
        }
      } catch {
        // Ignore malformed SSE payloads
      }
    }
  }

  yield `data: ${JSON.stringify({
    type: 'content_block_stop',
    index: 0,
  })}\n\n`;

  yield `data: ${JSON.stringify({
    type: 'message_delta',
    delta: {
      stop_reason: finishReason,
      stop_sequence: null,
    },
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  })}\n\n`;

  yield `data: ${JSON.stringify({
    type: 'message_stop',
  })}\n\n`;
}

/**
 * Translate OpenAI error response to Anthropic error format
 */
export function translateOpenAIErrorToAnthropic(
  error: unknown
): { type: 'error'; error: { type: string; message: string } } {
  const openAIError = error as {
    error?: { type?: string; message?: string };
    message?: string;
  };

  return {
    type: 'error',
    error: {
      type: openAIError.error?.type ?? 'api_error',
      message: openAIError.error?.message || openAIError.message || 'Upstream API error',
    },
  };
}

/**
 * Translate Anthropic error to OpenAI error format
 */
export function translateAnthropicErrorToOpenAI(error: unknown): OpenAIErrorResponse {
  // If it's already an Anthropic error format, translate it
  const err = error as { error?: { type?: string; message?: string }; message?: string };
  if (err.error?.type && err.error?.message) {
    return {
      error: {
        message: err.error.message,
        type: err.error.type,
        param: null,
        code: null,
      },
    };
  }

  // Generic error
  return {
    error: {
      message: err.message || 'An error occurred',
      type: 'internal_error',
      param: null,
      code: null,
    },
  };
}

/**
 * Validate OpenAI request and throw errors for unsupported features
 */
export function validateOpenAIRequest(request: OpenAIChatCompletionRequest): void {
  // Error on unsupported features that would change behavior
  if (request.n && request.n > 1) {
    throw new Error(
      'Multiple completions (n > 1) are not supported. Anthropic only returns one completion.'
    );
  }

  if (request.logprobs) {
    throw new Error('Log probabilities (logprobs) are not supported by Anthropic API.');
  }

  // Warn about ignored parameters (these won't cause errors but won't work as expected)
  if (request.presence_penalty !== undefined) {
    console.warn('Warning: presence_penalty is not supported by Anthropic and will be ignored');
  }

  if (request.frequency_penalty !== undefined) {
    console.warn('Warning: frequency_penalty is not supported by Anthropic and will be ignored');
  }

  if (request.logit_bias !== undefined) {
    console.warn('Warning: logit_bias is not supported by Anthropic and will be ignored');
  }
}
