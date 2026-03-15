#!/usr/bin/env node

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

type ParsedArgs = {
  command: string | null;
  commandArgs: string[];
  forceInteractive: boolean;
  forceNonInteractive: boolean;
  json: boolean;
  provider: ProviderSelection;
  help: boolean;
};

function supportsInteractiveTui(): boolean {
  return Boolean(
    process.stdin.isTTY &&
      process.stdout.isTTY &&
      process.env.TERM &&
      process.env.TERM !== 'dumb'
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  let forceInteractive = false;
  let forceNonInteractive = false;
  let json = false;
  let provider: ProviderSelection = 'all';
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
      index += 1;
      continue;
    }

    if (arg.startsWith('--provider=')) {
      provider = normalizeProviderSelection(arg.slice('--provider='.length));
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
  console.log(`code-router

Usage:
  code-router
  code-router serve [router flags]
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
  code-router serve --port 3000 --verbose
  code-router verify
  code-router models --provider openrouter
  code-router auth claude
  code-router logout all
  npx code-router
  npx code-router serve`);
}

function printDefaultNonInteractive(statusText: string): void {
  console.log('code-router\n');
  console.log('Interactive terminal not available. Using non-interactive mode.\n');
  console.log(statusText);
  console.log('\nCommands:');
  console.log('  code-router serve');
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

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.command;

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

    if (supportsInteractiveTui()) {
      await runInteractiveCli();
      return;
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
    case 'serve':
      await runRouterServer(parsed.commandArgs);
      return;
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
        await runClaudeOAuth();
        console.log('Claude authentication saved.');
        return;
      }
      if (target === 'openai' || target === 'chatgpt') {
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
