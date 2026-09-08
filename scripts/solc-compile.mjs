// 编译 ResourceERC721.sol 验证 Solidity 有效性 (Stage 1-B 合约门禁)
// 用法: node scripts/solc-compile.mjs  (错误非零退出)
import solc from 'solc';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'contracts/ResourceERC721.sol'), 'utf-8');
const input = {
  language: 'Solidity',
  sources: { 'ResourceERC721.sol': { content: src } },
  settings: { outputSelection: { '*': { '*': ['abi'] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter((e) => e.severity === 'error');
if (errs.length) {
  console.error('ResourceERC721.sol 编译失败:');
  errs.forEach((e) => console.error(e.formattedMessage));
  process.exit(1);
}
const abi = out.contracts['ResourceERC721.sol'].ResourceERC721.abi || [];
console.log(`[solc] ResourceERC721.sol compile OK · ABI funcs: ${abi.map((x) => x.name).filter(Boolean).join(', ')}`);
