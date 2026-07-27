import { createInterface } from 'node:readline/promises';

import { parseReplInput } from './cli.mjs';

function display(output, stream) {
  if (output === undefined) return;
  stream.write(`${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}\n`);
}

/** Runs a fixed-command REPL. `execute` owns browser operations and may return a displayable value. */
export async function runPlaygroundRepl({
  execute,
  input = process.stdin,
  output = process.stdout,
  prompt = 'playground> ',
} = {}) {
  const readline = createInterface({ input, output, prompt });
  let closed = false;
  readline.once('close', () => { closed = true; });
  const promptIfOpen = () => {
    if (!closed) readline.prompt();
  };
  output.write('playground repl — AX_* commands or .help; .quit to detach.\n');
  promptIfOpen();
  for await (const line of readline) {
    try {
      const action = parseReplInput(line);
      if (action.kind === 'empty') {
        promptIfOpen();
        continue;
      }
      if (action.kind === 'quit') break;
      display(await execute(action, readline), output);
    } catch (error) {
      output.write(`! ${error?.message || error}\n`);
    }
    promptIfOpen();
  }
  if (!closed) readline.close();
}
