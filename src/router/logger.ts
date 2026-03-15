import { AnthropicRequest, AnthropicResponse } from '../types.js';

export type LogLevel = 'quiet' | 'minimal' | 'medium' | 'maximum';

export class Logger {
  constructor(private level: LogLevel = 'medium') {}

  setLevel(level: LogLevel) {
    this.level = level;
  }

  startup(message: string) {
    // Always show startup messages unless quiet
    if (this.level !== 'quiet') {
      console.log(message);
    }
  }

  logRequest(
    requestId: string,
    timestamp: string,
    request: AnthropicRequest,
    hadSystemPrompt: boolean,
    response?: { status: number; data?: AnthropicResponse },
    error?: Error,
    endpointType: 'anthropic' | 'openai' = 'anthropic'
  ) {
    if (this.level === 'quiet') {
      return;
    }

    if (this.level === 'minimal') {
      this.logMinimal(requestId, timestamp, request, response, error, endpointType);
    } else if (this.level === 'medium') {
      this.logMedium(requestId, timestamp, request, hadSystemPrompt, response, error, endpointType);
    } else if (this.level === 'maximum') {
      this.logMaximum(
        requestId,
        timestamp,
        request,
        hadSystemPrompt,
        response,
        error,
        endpointType
      );
    }
  }

  logUpstreamRequest(
    provider: 'anthropic' | 'openai',
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: unknown
  ) {
    if (this.level !== 'maximum') {
      return;
    }

    const endpoint = provider === 'openai' ? 'OpenAI' : 'Anthropic';
    const maskedHeaders = { ...headers };
    if (maskedHeaders.Authorization && maskedHeaders.Authorization.startsWith('Bearer ')) {
      maskedHeaders.Authorization =
        `Bearer ${maskedHeaders.Authorization.slice(7, 12)}...${maskedHeaders.Authorization.slice(-4)}`;
    }

    console.log(`\n[${endpoint} FORWARD] ${method} ${url}`);
    console.log('Headers:');
    console.log(JSON.stringify(maskedHeaders, null, 2));

    if (body !== undefined) {
      console.log('Body:');
      console.log(JSON.stringify(body, null, 2));
    }

    console.log('='.repeat(80));
  }

  private logMinimal(
    requestId: string,
    timestamp: string,
    request: AnthropicRequest,
    response?: { status: number; data?: AnthropicResponse },
    error?: Error,
    endpointType: 'anthropic' | 'openai' = 'anthropic'
  ) {
    const status = error ? '✗ ERROR' : response ? `✓ ${response.status}` : '...';
    const tokens = response?.data?.usage
      ? `(in:${response.data.usage.input_tokens} out:${response.data.usage.output_tokens})`
      : '';
    const endpoint = endpointType === 'openai' ? '[OpenAI]' : '[Anthropic]';

    console.log(
      `[${timestamp.substring(11, 19)}] ${endpoint} ${status} ${request.model} ${tokens}`
    );
  }

  private logMedium(
    requestId: string,
    timestamp: string,
    request: AnthropicRequest,
    hadSystemPrompt: boolean,
    response?: { status: number; data?: AnthropicResponse },
    error?: Error,
    endpointType: 'anthropic' | 'openai' = 'anthropic'
  ) {
    const endpoint = endpointType === 'openai' ? 'OpenAI' : 'Anthropic';
    console.log(`\n[${timestamp}] [${requestId}] Incoming ${endpoint} request`);
    console.log(`  Model: ${request.model}`);
    console.log(`  Max tokens: ${request.max_tokens}`);

    if (error) {
      console.log(`  ✗ Error: ${error.message}`);
    } else if (response) {
      console.log(`  → Forwarding upstream...`);
      if (response.status >= 200 && response.status < 300) {
        console.log(`  ✓ Success (${response.status})`);
        if (response.data?.usage) {
          console.log(
            `  Tokens: input=${response.data.usage.input_tokens}, output=${response.data.usage.output_tokens}`
          );
        }
      } else {
        console.log(`  ✗ Error (${response.status})`);
      }
    }
  }

  private logMaximum(
    requestId: string,
    timestamp: string,
    request: AnthropicRequest,
    hadSystemPrompt: boolean,
    response?: { status: number; data?: AnthropicResponse },
    error?: Error,
    endpointType: 'anthropic' | 'openai' = 'anthropic'
  ) {
    const endpoint = endpointType === 'openai' ? 'OpenAI' : 'Anthropic';
    console.log('\n' + '='.repeat(80));
    console.log(`[${timestamp}] [${requestId}] ${endpoint} REQUEST`);
    console.log('='.repeat(80));
    console.log('Request Body (Anthropic format):');
    console.log(JSON.stringify(request, null, 2));

    if (endpointType === 'openai') {
      console.log('\n✓ OpenAI-compatible request normalized');
      const contentSummary = summarizeAnthropicMessages(request);
      if (contentSummary) {
        console.log(`Content Summary: ${contentSummary}`);
      }

      const imageCount = countImageBlocks(request);
      if (imageCount > 0) {
        console.log(`Image Blocks: ${imageCount}`);
      }
    }

    if (!hadSystemPrompt) {
      console.log('\n✓ Injected required system prompt');
    } else {
      console.log('\n✓ System prompt already present');
    }

    console.log('✓ OAuth token validated');
    console.log('→ Forwarding upstream...\n');

    if (error) {
      console.log('='.repeat(80));
      console.log('ERROR');
      console.log('='.repeat(80));
      console.log(error);
    } else if (response) {
      console.log('='.repeat(80));
      console.log(`RESPONSE (${response.status})`);
      console.log('='.repeat(80));
      console.log(JSON.stringify(response.data, null, 2));
    }
    console.log('='.repeat(80) + '\n');
  }

  info(message: string) {
    if (this.level === 'maximum') {
      console.log(message);
    }
  }

  error(message: string, error?: unknown) {
    // Always show errors
    console.error(message, error || '');
  }
}

function summarizeAnthropicMessages(request: AnthropicRequest): string {
  return request.messages
    .slice(0, 6)
    .map((message, messageIndex) => {
      if (typeof message.content === 'string') {
        const preview = message.content.replace(/\s+/g, ' ').trim().slice(0, 60);
        return `${messageIndex + 1}:${message.role}[text${preview ? `="${preview}"` : ''}]`;
      }

      const blockTypes = message.content
        .map((block) => {
          const blockType = typeof block?.type === 'string' ? block.type : 'unknown';
          if (blockType === 'image') {
            const source =
              block && typeof block === 'object' && block.source && typeof block.source === 'object'
                ? (block.source as Record<string, unknown>)
                : null;
            const sourceType = typeof source?.type === 'string' ? source.type : 'unknown';
            return `image:${sourceType}`;
          }
          return blockType;
        })
        .join(',');
      return `${messageIndex + 1}:${message.role}[${blockTypes || 'empty'}]`;
    })
    .join(' | ');
}

function countImageBlocks(request: AnthropicRequest): number {
  return request.messages.reduce((count, message) => {
    if (!Array.isArray(message.content)) {
      return count;
    }

    return (
      count +
      message.content.filter(
        (block) => !!block && typeof block === 'object' && block.type === 'image'
      ).length
    );
  }, 0);
}

function findUnexpectedContentBlock(
  request: AnthropicRequest
): { messageIndex: number; blockIndex: number; block: Record<string, unknown> } | null {
  for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex += 1) {
    const message = request.messages[messageIndex];
    if (!Array.isArray(message?.content)) {
      continue;
    }

    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      const block = message.content[blockIndex] as Record<string, unknown>;
      const blockType = typeof block?.type === 'string' ? block.type : 'unknown';
      if (blockType !== 'text' && blockType !== 'tool_use' && blockType !== 'tool_result') {
        return { messageIndex, blockIndex, block };
      }
    }
  }

  return null;
}

export const logger = new Logger();
