import { CLIInterface } from './cli/interface.js';
import { initMinimax } from './llm/minimax.js';
import * as readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function prompt(question: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(question, resolve);
  });
}

async function main() {
  const apiKey = process.env.MINIMAX_API_KEY;

  if (apiKey) {
    initMinimax({ apiKey });
    console.log('✅ Minimax LLM 已初始化\n');
  } else {
    console.log('⚠️  MINIMAX_API_KEY 未设置，摘要功能将受限\n');
  }

  const cli = new CLIInterface();
  await cli.start();
}

main().catch(console.error);