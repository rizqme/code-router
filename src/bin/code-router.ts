#!/usr/bin/env node

import { execSync, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';
import {
  formatModelsText,
  formatStatusText,
  formatVerifyText,
  listModels,
  loadStatusSnapshot,
  logout,
  runClaudeOAuth,
  runOpenAIOAuth,
  verifySubscriptions,
  type ProviderSelection,
} from '../commands.js';
import { saveTokens } from '../token-manager.js';
import { saveOpenAIAuthState, saveOpenAIKey } from '../openai-token-manager.js';
import type { OAuthTokens } from '../types.js';

const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
) as { version?: string };
const VERSION = PACKAGE_VERSION.version || '0.0.0';

type ParsedArgs = {
  command: string | null;
  commandArgs: string[];
  forceInteractive: boolean;
  forceNonInteractive: boolean;
  json: boolean;
  provider: ProviderSelection;
  providerSpecified: boolean;
  help: boolean;
};

function supportsInteractiveTui(): boolean {
  return Boolean(process.stdout.isTTY && process.env.TERM && process.env.TERM !== 'dumb');
}

function parseArgs(argv: string[]): ParsedArgs {
  let forceInteractive = false;
  let forceNonInteractive = false;
  let json = false;
  let provider: ProviderSelection = 'all';
  let providerSpecified = false;
  let help = false;
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;

    if (arg === '--interactive') {
      forceInteractive = true;
      continue;
    }

    if (arg === '--no-interactive') {
      forceNonInteractive = true;
      continue;
    }

    if (arg === '--json') {
      json = true;
      continue;
    }

    if (arg === '--help' || arg === '-h' || arg === 'help') {
      help = true;
      continue;
    }

    if (arg === '--provider' && argv[index + 1]) {
      provider = normalizeProviderSelection(argv[index + 1]!);
      providerSpecified = true;
      index += 1;
      continue;
    }

    if (arg.startsWith('--provider=')) {
      provider = normalizeProviderSelection(arg.slice('--provider='.length));
      providerSpecified = true;
      continue;
    }

    positionals.push(arg);
  }

  return {
    command: positionals[0] || null,
    commandArgs: positionals.slice(1),
    forceInteractive,
    forceNonInteractive,
    json,
    provider,
    providerSpecified,
    help,
  };
}

function normalizeProviderSelection(value: string): ProviderSelection {
  const normalized = value.toLowerCase().trim();
  if (
    normalized === 'all' ||
    normalized === 'claude' ||
    normalized === 'openai' ||
    normalized === 'openrouter'
  ) {
    return normalized;
  }

  throw new Error(`Unsupported provider: ${value}`);
}

function printHelp(): void {
  console.log(`code-router v${VERSION}

Usage:
  code-router
  code-router serve [router flags]
  code-router serve start [router flags]
  code-router serve stop [--port PORT]
  code-router serve apis [--provider openai|claude|openrouter|all]
  code-router verify [--provider claude|openai|all] [--json]
  code-router models [--provider claude|openai|openrouter|all] [--json]
  code-router auth <claude|openai|status>
  code-router logout <claude|openai|all>
  code-router status [--json]

Flags:
  --interactive       Force the Ink TUI
  --no-interactive    Force text CLI mode
  --json              JSON output for status, verify, and models
  --provider          Filter provider output
  --help, -h          Show this help

Examples:
  code-router
  code-router serve --port 3344 --verbose
  code-router serve start
  code-router serve stop
  code-router serve apis --provider claude
  code-router verify
  code-router models --provider openrouter
  code-router auth claude
  code-router auth claude --access-token <token> --refresh-token <token>
  code-router auth openai --token <token>
  code-router logout all
  npx code-router
  npx code-router serve`);
}

function printDefaultNonInteractive(statusText: string): void {
  console.log(`code-router v${VERSION}\n`);
  console.log('Interactive terminal not available. Using non-interactive mode.\n');
  console.log(statusText);
  console.log('\nCommands:');
  console.log('  code-router serve');
  console.log('  code-router serve start');
  console.log('  code-router serve stop');
  console.log('  code-router serve apis');
  console.log('  code-router verify');
  console.log('  code-router models');
  console.log('  code-router auth status');
  console.log('  code-router logout all');
}

async function importRuntimeModule(sourceRelativePath: string, distRelativePath: string): Promise<void> {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  const isSourceRuntime = currentFile.includes('/src/');
  const targetPath = resolve(currentDir, isSourceRuntime ? sourceRelativePath : distRelativePath);
  await import(pathToFileURL(targetPath).href);
}

async function runInteractiveCli(): Promise<void> {
  await importRuntimeModule('../cli.tsx', '../cli.js');
}

async function runRouterServer(args: string[]): Promise<void> {
  process.argv = [process.argv[0]!, process.argv[1]!, ...args];
  await importRuntimeModule('../router/server.ts', '../router/server.js');
}

function getOption(args: string[], name: string, shortName?: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === `--${name}` && args[index + 1]) {
      return args[index + 1]!;
    }
    if (shortName && arg === `-${shortName}` && args[index + 1]) {
      return args[index + 1]!;
    }
    if (arg.startsWith(`--${name}=`)) {
      return arg.slice(name.length + 3);
    }
  }
  return undefined;
}

function resolveServePort(args: string[]): number {
  const explicitPort = getOption(args, 'port', 'p');
  const parsedPort = explicitPort ? Number(explicitPort) : Number(process.env.ROUTER_PORT || '3344');
  return Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3344;
}

async function isRouterRunning(port: number): Promise<boolean> {
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

function startRouterDetached(args: string[]): number | undefined {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  const isSourceRuntime = currentFile.includes('/src/');

  if (isSourceRuntime) {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npmCommand, ['run', 'router', '--', ...args], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return child.pid;
  }

  const serverPath = resolve(currentDir, '../router/server.js');
  const child = spawn(process.execPath, [serverPath, ...args], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

function findRouterPids(port: number): number[] {
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

function formatApis(provider: ProviderSelection, providerSpecified: boolean): string {
  const sections: string[] = [];
  const selectedProvider = providerSpecified ? provider : 'openai';
  const providers =
    selectedProvider === 'all'
      ? (['openai', 'claude', 'openrouter'] as const)
      : ([selectedProvider] as const);

  for (const currentProvider of providers) {
    if (sections.length > 0) {
      sections.push('');
    }

    if (currentProvider === 'claude') {
      sections.push('Claude API');
      sections.push('  Base URL: http://localhost:3344');
      sections.push('  POST /v1/messages');
      sections.push('  GET  /v1/models');
      continue;
    }

    if (currentProvider === 'openrouter') {
      sections.push('OpenRouter API');
      sections.push('  Base URL: http://localhost:3344/v1');
      sections.push('  POST /chat/completions');
      sections.push('  POST /responses');
      sections.push('  GET  /models?provider=openrouter');
      sections.push('  Model IDs: openai/gpt-5.4, anthropic/claude-sonnet-4-6');
      continue;
    }

    sections.push('OpenAI API');
    sections.push('  Base URL: http://localhost:3344/v1');
    sections.push('  POST /chat/completions');
    sections.push('  POST /responses');
    sections.push('  GET  /models');
  }

  return sections.join('\n');
}

async function saveManualClaudeTokens(args: string[]): Promise<void> {
  const accessToken = getOption(args, 'access-token');
  const refreshToken = getOption(args, 'refresh-token');
  const scope =
    getOption(args, 'scope') || 'org:create_api_key user:profile user:inference';
  const hoursInput = getOption(args, 'expires-hours') || '8';
  const hours = Number(hoursInput);
  const expiresIn = Number.isFinite(hours) && hours > 0 ? Math.floor(hours * 3600) : 8 * 3600;

  if (!accessToken || !refreshToken) {
    throw new Error(
      'Manual Claude auth requires --access-token <token> and --refresh-token <token>'
    );
  }

  const tokens: OAuthTokens = {
    access_token: accessToken.trim(),
    refresh_token: refreshToken.trim(),
    expires_in: expiresIn,
    token_type: 'Bearer',
    scope,
    expires_at: Date.now() + expiresIn * 1000,
    created_at: new Date().toISOString(),
  };

  await saveTokens(tokens);
}

async function saveManualOpenAIAuth(args: string[]): Promise<void> {
  const apiKey = getOption(args, 'token') || getOption(args, 'api-key');
  const accessToken = getOption(args, 'access-token');
  const refreshToken = getOption(args, 'refresh-token');
  const accountId = getOption(args, 'account-id');

  if (!apiKey) {
    throw new Error('Manual ChatGPT auth requires --token <token>');
  }

  if (accessToken || refreshToken || accountId) {
    await saveOpenAIAuthState({
      source: 'oauth',
      apiKey: apiKey.trim(),
      accessToken: accessToken?.trim(),
      refreshToken: refreshToken?.trim(),
      accountId: accountId?.trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  await saveOpenAIKey(apiKey.trim());
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.command;

  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    console.log(VERSION);
    return;
  }

  if (parsed.help) {
    printHelp();
    return;
  }

  if (!command) {
    if (parsed.forceNonInteractive) {
      const status = await loadStatusSnapshot();
      const statusText = formatStatusText(status);
      if (parsed.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        printDefaultNonInteractive(statusText);
      }
      return;
    }

    if (parsed.forceInteractive && !supportsInteractiveTui()) {
      console.error('Interactive terminal not available.');
      process.exitCode = 1;
      return;
    }

    if (parsed.forceInteractive || supportsInteractiveTui()) {
      try {
        await runInteractiveCli();
        return;
      } catch (error) {
        if (parsed.forceInteractive) {
          throw error;
        }
      }
    }

    const status = await loadStatusSnapshot();
    const statusText = formatStatusText(status);
    if (parsed.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      printDefaultNonInteractive(statusText);
    }
    return;
  }

  switch (command) {
    case 'serve': {
      const serveSubcommand = parsed.commandArgs[0] || null;
      const serveArgs = serveSubcommand ? parsed.commandArgs.slice(1) : parsed.commandArgs;

      if (serveSubcommand === 'start') {
        const port = resolveServePort(serveArgs);
        if (await isRouterRunning(port)) {
          console.log(`Router is already running on http://localhost:${port}`);
          return;
        }

        startRouterDetached(serveArgs);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const running = await isRouterRunning(port);
        console.log(
          running
            ? `Router is running on http://localhost:${port}`
            : `Started router process for http://localhost:${port}`
        );
        return;
      }

      if (serveSubcommand === 'stop') {
        const port = resolveServePort(serveArgs);
        const pids = findRouterPids(port);
        if (pids.length === 0) {
          console.log(`Router is not running on http://localhost:${port}`);
          return;
        }

        for (const pid of pids) {
          process.kill(pid, 'SIGTERM');
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
        console.log(
          (await isRouterRunning(port))
            ? `Router is still running on http://localhost:${port}`
            : `Router stopped on http://localhost:${port}`
        );
        return;
      }

      if (serveSubcommand === 'apis') {
        console.log(formatApis(parsed.provider, parsed.providerSpecified));
        return;
      }

      await runRouterServer(parsed.commandArgs);
      return;
    }
    case 'verify': {
      if (parsed.provider === 'openrouter') {
        throw new Error('verify does not support provider=openrouter');
      }
      const result = await verifySubscriptions(parsed.provider);
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatVerifyText(parsed.provider, result));
      }
      return;
    }
    case 'models': {
      const result = await listModels(parsed.provider);
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatModelsText(parsed.provider, result));
      }
      return;
    }
    case 'status': {
      const status = await loadStatusSnapshot();
      if (parsed.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log(formatStatusText(status));
      }
      return;
    }
    case 'auth': {
      const target = parsed.commandArgs[0] || 'status';
      if (target === 'status') {
        const status = await loadStatusSnapshot();
        if (parsed.json) {
          console.log(JSON.stringify(status, null, 2));
        } else {
          console.log(formatStatusText(status));
        }
        return;
      }
      if (target === 'claude') {
        if (getOption(parsed.commandArgs, 'access-token') || getOption(parsed.commandArgs, 'refresh-token')) {
          await saveManualClaudeTokens(parsed.commandArgs.slice(1));
          console.log('Claude authentication saved.');
          return;
        }
        await runClaudeOAuth();
        console.log('Claude authentication saved.');
        return;
      }
      if (target === 'openai' || target === 'chatgpt') {
        if (
          getOption(parsed.commandArgs, 'token') ||
          getOption(parsed.commandArgs, 'api-key') ||
          getOption(parsed.commandArgs, 'access-token') ||
          getOption(parsed.commandArgs, 'refresh-token') ||
          getOption(parsed.commandArgs, 'account-id')
        ) {
          await saveManualOpenAIAuth(parsed.commandArgs.slice(1));
          console.log('ChatGPT authentication saved.');
          return;
        }
        await runOpenAIOAuth();
        console.log('ChatGPT authentication saved.');
        return;
      }
      throw new Error(`Unsupported auth target: ${target}`);
    }
    case 'logout': {
      const target = (parsed.commandArgs[0] || 'all') as 'claude' | 'openai' | 'all';
      if (target !== 'claude' && target !== 'openai' && target !== 'all') {
        throw new Error(`Unsupported logout target: ${target}`);
      }
      await logout(target);
      console.log(`Removed saved credentials for ${target}.`);
      return;
    }
    default:
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
