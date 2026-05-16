import { DeepThinkingEngine } from '../thinking/engine.js';

export interface SubTask {
  id: string;
  description: string;
  priority: number;
}

export interface AgentResult {
  taskId: string;
  output: string;
  success: boolean;
  metadata?: Record<string, unknown>;
}

export class AgentCoordinator {
  private engine: DeepThinkingEngine;

  constructor(maxDepth: number = 3) {
    this.engine = new DeepThinkingEngine(maxDepth);
  }

  async dispatch(prompt: string, parallelCount: number = 3): Promise<AgentResult[]> {
    const tasks = this.splitTask(prompt, parallelCount);

    const results = await Promise.all(
      tasks.map(task => this.executeTask(task))
    );

    return this.aggregate(results);
  }

  private splitTask(prompt: string, count: number): SubTask[] {
    const words = prompt.split(/\s+/);
    const chunkSize = Math.ceil(words.length / count);
    const chunks: SubTask[] = [];

    for (let i = 0; i < count; i++) {
      const chunk = words.slice(i * chunkSize, (i + 1) * chunkSize).join(' ');
      if (chunk) {
        chunks.push({
          id: `task-${i}`,
          description: chunk,
          priority: i
        });
      }
    }
    return chunks;
  }

  private async executeTask(task: SubTask): Promise<AgentResult> {
    try {
      const thinkResult = await this.engine.think(task.description);
      return {
        taskId: task.id,
        output: thinkResult.finalOutput,
        success: true
      };
    } catch (error) {
      return {
        taskId: task.id,
        output: String(error),
        success: false
      };
    }
  }

  private aggregate(results: AgentResult[]): AgentResult[] {
    return results.sort((a, b) => a.taskId.localeCompare(b.taskId));
  }
}
