import { getTools, PortingModule } from './tools.js';
import { ToolPermissionContext } from './constraint/permission.js';

export interface ToolPool {
  tools: PortingModule[];
  simpleMode: boolean;
  includeMcp: boolean;
}

export function assembleToolPool(
  simpleMode: boolean = false,
  includeMcp: boolean = true,
  permissionContext?: ToolPermissionContext
): ToolPool {
  return {
    tools: getTools(simpleMode),
    simpleMode,
    includeMcp,
  };
}
