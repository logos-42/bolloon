import { shellExec } from '../src/agents/shell-tool.js';

(async () => {
  // Windows 常用: cd 打印当前目录
  const tests = [
    { cmd: 'cd', args: [], name: 'cd (no args)' },
    { cmd: 'git', args: ['rev-parse', '--show-toplevel'], name: 'git root' },
    { cmd: 'dir', args: ['src'], name: 'dir src' },
    { cmd: 'type', args: ['src\\agents\\intent-classifier.ts'], name: 'type file' },
  ];
  for (const t of tests) {
    console.log(`\n=== ${t.name} ===`);
    const result = await shellExec(t.cmd, t.args, { timeoutMs: 5000 });
    console.log('success:', result.success);
    console.log('output:', (result.output || '').substring(0, 300));
    if (result.error) console.log('error:', result.error.substring(0, 200));
  }
})();