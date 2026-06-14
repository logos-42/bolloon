/**
 * tool-manifest/types.ts — 工具清单的类型
 *
 * 设计原则: schema 在代码侧(结构化数据), description/when-to-use 在代码侧,
 * prompt 里只嵌"调用格式 + 名字 + 一句话描述" — 节省 LLM 注意力.
 */

export interface ToolParameter {
  name: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object' | 'enum';
  required: boolean;
  description: string;
  /** 枚举值 (type='enum' 时) */
  enumValues?: string[];
  /** 默认值 (LLM 不传时用) */
  default?: string | number | boolean;
  /** 嵌套对象的字段 (type='object' 时) */
  properties?: ToolParameter[];
  /** 数组元素 (type='array' 时) */
  items?: ToolParameter;
  /** 数组最小项数 (type='array' 时) */
  minItems?: number;
  /** 数组最大项数 (type='array' 时) */
  maxItems?: number;
  /** 数字最小值 (type='integer'/'number' 时) */
  minimum?: number;
  /** 数字最大值 (type='integer'/'number' 时) */
  maximum?: number;
  /** 字符串格式约束 (e.g. 'uri', 'date-time') */
  format?: string;
}

export interface ToolManifest {
  /** 工具 ID, 跟 prompt 里调用的 {name} 一致 */
  id: string;
  /** 显示名 */
  name: string;
  /** 一句话描述 (进 prompt) */
  oneLine: string;
  /** 详细描述 (代码侧, 不进 prompt) */
  description: string;
  /** 何时使用 (进 prompt) */
  whenToUse: string[];
  /** 何时不使用 (进 prompt) */
  whenNotToUse: string[];
  /** 输入参数 schema (代码侧, 不进 prompt) */
  parameters: ToolParameter[];
  /** 一个调用示例 (进 prompt, 1-3 行) */
  callExample: string;
  /** 在 system-prompt 里对应的 layer ID (可选) */
  layerId?: string;
}
