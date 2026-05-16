import { PortingModule } from './models.js';
import { getCommands } from './commands.js';

export interface CommandGraph {
  builtins: PortingModule[];
  pluginLike: PortingModule[];
  skillLike: PortingModule[];
}

export function buildCommandGraph(): CommandGraph {
  const commands = getCommands();
  return {
    builtins: commands.filter(m => 
      !m.sourceHint.toLowerCase().includes('plugin') && 
      !m.sourceHint.toLowerCase().includes('skills')
    ),
    pluginLike: commands.filter(m => m.sourceHint.toLowerCase().includes('plugin')),
    skillLike: commands.filter(m => m.sourceHint.toLowerCase().includes('skills')),
  };
}
