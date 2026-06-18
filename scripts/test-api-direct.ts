import { initMinimax, getMinimax } from '../src/constraints/index.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  try {
    initMinimax({ provider: 'minimax', model: 'MiniMax-M2.7' });
    const m = getMinimax();
    console.log('Provider:', m.provider, 'Model:', m.model);
    const r = await m.chat('Respond with just: OK');
    console.log('SUCCESS:', JSON.stringify(r));
  } catch(e: any) {
    console.error('ERROR:', e.message);
  }
  process.exit(0);
}
main();
