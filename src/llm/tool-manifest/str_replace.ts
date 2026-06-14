import type { ToolManifest } from './types.js';

export const str_replace: ToolManifest = {
  id: 'str_replace',
  name: 'str_replace',
  oneLine: '将文件中的唯一字符串替换为另一个.',
  description: 'old_str 必须与原始文件内容完全匹配且只出现一次. 从 view 输出复制时, 不要包含行号前缀(空格 + 行号 + 制表符). 在编辑前立即查看文件; 任何成功的 str_replace 之后, 该文件之前的 view 输出已失效 — 在对同一文件进行进一步编辑之前请重新查看. /mnt/* 路径只读, 需先复制到可写位置.',
  whenToUse: [
    '编辑已有文件的小改动',
    '精确替换单段文本',
  ],
  whenNotToUse: [
    '创建新文件 (用 create_file)',
    '完全重写文件 (用 create_file + 删除)',
  ],
  parameters: [
    { name: 'description', type: 'string', required: true, description: '为什么我要做这个编辑' },
    { name: 'old_str', type: 'string', required: true, description: '要被替换的字符串 (必须唯一)' },
    { name: 'new_str', type: 'string', required: true, description: '新字符串 (空字符串 = 删除)', default: '' },
    { name: 'path', type: 'string', required: true, description: '文件路径' },
  ],
  callExample: `[TOOL:str_replace]
[P:description]修复 typo
[P:old_str]recieve
[P:new_str]receive
[P:path]/home/bolloon/main.py
[ENDTOOL]`,
  layerId: 'tool.manifest',
};
