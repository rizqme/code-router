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

/**
 * Translate OpenAI Chat Completion request to Anthropic Messages API request
 */
export function translateOpenAIToAnthropic(
  openaiRequest: OpenAIChatCompletionRequest
): AnthropicRequest {
  // Extract and combine all system messages
  const systemMessages: string[] = [];
  const conversationMessages: OpenAIMessage[] = [];

  for (const msg of openaiRequest.messages) {
    if (msg.role === 'system') {
      systemMessages.push(msg.content || '');
    } else {
      conversationMessages.push(msg);
    }
  }

  // Consolidate consecutive same-role messages for Anthropic's alternation requirement
  const anthropicMessages: Message[] = [];
  let currentRole: 'user' | 'assistant' | null = null;
  let currentContent: string[] = [];

  for (const msg of conversationMessages) {
    if (msg.role === 'tool') {
      // Skip tool messages for now - they need special handling
      continue;
    }

    const role = msg.role as 'user' | 'assistant';

    if (role === currentRole) {
      // Same role, accumulate content
      currentContent.push(msg.content || '');
    } else {
      // Role changed, flush current message
      if (currentRole && currentContent.length > 0) {
        anthropicMessages.push({
          role: currentRole,
          content: currentContent.join('\n\n'),
        });
      }
      currentRole = role;
      currentContent = [msg.content || ''];
    }
  }

  // Flush final message
  if (currentRole && currentContent.length > 0) {
    anthropicMessages.push({
      role: currentRole,
      content: currentContent.join('\n\n'),
    });
  }

  // Translate tools if present
  let anthropicTools: Tool[] | undefined;
  if (openaiRequest.tools && openaiRequest.tools.length > 0) {
    anthropicTools = openaiRequest.tools.map(translateOpenAIToolToAnthropic);
  }

  // Build the Anthropic request
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

  // Add tools if present
  if (anthropicTools && anthropicTools.length > 0) {
    anthropicRequest.tools = anthropicTools;
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

    const textContent = message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && !!block.text)
      .map((block) => block.text)
      .join('\n\n');

    const toolUseBlocks = message.content.filter((block) => block.type === 'tool_use');
    const toolResultBlocks = message.content.filter((block) => block.type === 'tool_result');

    if (textContent.length > 0 || toolUseBlocks.length > 0 || toolResultBlocks.length > 0) {
      const toolContent = [
        textContent,
        ...toolUseBlocks.map((block) => `[tool_use:${String(block.id ?? 'unknown')}]`),
        ...toolResultBlocks.map((block) => `[tool_result:${String(block.id ?? 'unknown')}]`),
      ]
        .filter((value) => value.length > 0)
        .join('\n\n');

      messages.push({
        role: message.role,
        content: toolContent || '[unsupported content block omitted]',
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

          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            // Text content delta
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
          } else if (event.type === 'message_delta' && event.usage) {
            // Update token counts
            totalOutputTokens = event.usage.output_tokens || totalOutputTokens;
          } else if (event.type === 'message_start' && event.message?.usage) {
            // Initial token count
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
        finish_reason: 'stop',
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
