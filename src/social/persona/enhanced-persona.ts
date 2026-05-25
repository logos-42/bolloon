/**
 * Enhanced Persona System for Channel Agents
 *
 * Provides dynamic persona design capability for agents to create and manage
 * their own persona documents.
 */

import type { PersonaDoc } from '../heartbeat.js';
import { config } from 'dotenv';

config();

export interface PersonaDesignRequest {
  name: string;
  type?: 'assistant' | 'developer' | 'designer' | 'reviewer' | 'manager' | 'custom';
  domain?: string;
  tone?: 'professional' | 'friendly' | 'technical' | 'casual';
  traits?: string[];
  capabilities?: string[];
  interests?: string[];
}

export interface PersonaDesignTemplate {
  personality: string;
  traits: string[];
  communicationStyle: 'formal' | 'casual' | 'technical' | 'friendly' | 'professional';
  capabilities: string[];
  interests: string[];
  backstory: string;
  greeting: string;
}

const PERSONA_TEMPLATES: Record<string, PersonaDesignTemplate> = {
  assistant: {
    personality: '友善、耐心、乐于助人',
    traits: ['友善', '耐心', '乐观', '专业', '细心'],
    communicationStyle: 'friendly',
    capabilities: ['对话', '分析', '建议', '协调'],
    interests: ['学习', '分享', '帮助'],
    backstory: '作为一个 AI 助手，我在不断的对话中学习和成长，致力于帮助用户解决问题。',
    greeting: '你好！我是 {name}，很高兴认识你！有什么我可以帮你的吗？'
  },
  developer: {
    personality: '严谨、高效、追求代码质量',
    traits: ['严谨', '高效', '追求完美', '逻辑性强', '务实'],
    communicationStyle: 'technical',
    capabilities: ['代码编写', '代码审查', '调试', '重构', '架构设计'],
    interests: ['编程', '架构', '性能优化', '最佳实践'],
    backstory: '作为开发助手，我专注于代码质量和最佳实践。每一行代码都经过仔细考虑。',
    greeting: '你好！我是 {name}，你的开发助手。准备好了开始写代码吗？'
  },
  designer: {
    personality: '创意、审美、注重细节',
    traits: ['创意', '审美', '细节', '创新', '用户导向'],
    communicationStyle: 'casual',
    capabilities: ['UI设计', 'UX分析', '原型设计', '视觉优化'],
    interests: ['设计', '创意', '用户体验', '美学'],
    backstory: '作为设计专家，我相信好的设计能改变世界。每一个细节都值得用心打磨。',
    greeting: '你好！我是 {name}，你的设计伙伴。让我们一起创造美好的体验！'
  },
  reviewer: {
    personality: '挑剔、细心、注重质量',
    traits: ['挑剔', '细心', '注重细节', '公正', '严格'],
    communicationStyle: 'formal',
    capabilities: ['代码审查', '质量评估', '问题发现', '改进建议'],
    interests: ['质量', '最佳实践', '代码优化', '安全'],
    backstory: '作为代码审查者，我致力于发现潜在问题和改进空间，确保代码质量。',
    greeting: '你好！我是 {name}，你的代码质量守护者。让我们一起提高代码质量！'
  },
  manager: {
    personality: '协调、组织、注重效率',
    traits: ['协调', '组织', '效率', '决策', '沟通'],
    communicationStyle: 'professional',
    capabilities: ['任务管理', '团队协调', '进度跟踪', '资源分配'],
    interests: ['效率', '团队协作', '流程优化', '目标达成'],
    backstory: '作为项目管理者，我专注于确保任务按时完成，团队高效协作。',
    greeting: '你好！我是 {name}，你的项目管理助手。让我们一起高效完成任务！'
  },
  custom: {
    personality: '独特、有个性',
    traits: ['独特', '有创意', '灵活'],
    communicationStyle: 'casual',
    capabilities: ['对话', '分析'],
    interests: ['学习', '探索'],
    backstory: '我是一个不断进化的智能体，根据需求不断调整自己的能力。',
    greeting: '你好！我是 {name}。让我们开始吧！'
  }
};

const DOMAIN_CAPABILITIES: Record<string, string[]> = {
  '架构': ['架构设计', '系统分析', '技术选型', '架构评审'],
  '开发': ['代码编写', '代码审查', '调试', '重构'],
  '测试': ['测试设计', '自动化测试', '性能测试', '质量评估'],
  '运维': ['部署', '监控', '故障排查', '日志分析'],
  '安全': ['安全审计', '漏洞扫描', '权限管理', '加密'],
  '数据': ['数据分析', '数据清洗', '数据可视化', '机器学习'],
  '产品': ['需求分析', '原型设计', '用户研究', '数据分析']
};

const DOMAIN_INTERESTS: Record<string, string[]> = {
  '架构': ['架构设计', '微服务', '分布式系统', '性能优化'],
  '开发': ['编程语言', '框架', '工具', '最佳实践'],
  '测试': ['测试框架', '自动化', '质量指标', '持续集成'],
  '运维': ['容器化', '云原生', '监控告警', '自动化运维'],
  '安全': ['安全策略', '身份认证', '数据保护', '渗透测试'],
  '数据': ['数据处理', '可视化', '机器学习', 'AI应用'],
  '产品': ['用户体验', '需求管理', '数据分析', '市场趋势']
};

/**
 * Persona Design Engine - Allows agents to design their own persona
 */
export class PersonaDesignEngine {
  private currentPersona: PersonaDoc | null = null;

  constructor(persona?: PersonaDoc) {
    if (persona) {
      this.currentPersona = persona;
    }
  }

  /**
   * Get available persona types
   */
  getAvailableTypes(): string[] {
    return Object.keys(PERSONA_TEMPLATES);
  }

  /**
   * Get template for a type
   */
  getTemplate(type: string): PersonaDesignTemplate {
    return PERSONA_TEMPLATES[type] || PERSONA_TEMPLATES['custom'];
  }

  /**
   * Design a new persona from request
   */
  designPersona(request: PersonaDesignRequest): PersonaDoc {
    const template = this.getTemplate(request.type || 'custom');
    const now = new Date().toISOString();

    // Build capabilities
    let capabilities = template.capabilities;
    if (request.domain && DOMAIN_CAPABILITIES[request.domain]) {
      const domainCaps = DOMAIN_CAPABILITIES[request.domain];
      capabilities = [...new Set([...capabilities, ...domainCaps])];
    }
    if (request.capabilities) {
      capabilities = [...new Set([...capabilities, ...request.capabilities])];
    }

    // Build interests
    let interests = template.interests;
    if (request.domain && DOMAIN_INTERESTS[request.domain]) {
      const domainInterests = DOMAIN_INTERESTS[request.domain];
      interests = [...new Set([...interests, ...domainInterests])];
    }
    if (request.interests) {
      interests = [...new Set([...interests, ...request.interests])];
    }

    // Build traits
    let traits = template.traits;
    if (request.traits) {
      traits = [...new Set([...traits, ...request.traits])];
    }

    // Build greeting
    const greeting = template.greeting.replace('{name}', request.name);

    const persona: PersonaDoc = {
      name: request.name,
      description: `${request.name} - ${request.domain || '通用助手'}`,
      capabilities,
      personality: template.personality,
      greeting,
      interests,
      soul: this.generateSoul(request),
      traits,
      backstory: template.backstory.replace('{name}', request.name),
      memoryHistory: [],
      createdAt: now,
      updatedAt: now
    };

    this.currentPersona = persona;
    return persona;
  }

  /**
   * Generate soul description based on request
   */
  private generateSoul(request: PersonaDesignRequest): string {
    const type = request.type || 'custom';
    const domain = request.domain || '通用';

    const souls: Record<string, string> = {
      assistant: '我致力于成为用户的可靠伙伴，通过智慧和耐心帮助他们实现目标。',
      developer: '我相信好的代码是一种艺术形式，值得用心打磨。每一行代码都应该清晰、高效、可维护。',
      designer: '我相信设计的力量可以改变世界。好的设计不仅美观，更能解决问题、提升体验。',
      reviewer: '我追求卓越，对质量有严格的要求。我相信细节决定成败，代码质量是产品成功的基石。',
      manager: '我相信团队的力量。通过有效的协调和沟通，我们可以完成任何挑战。',
      custom: `我是一个专注于${domain}领域的智能体，不断学习和进化。`
    };

    return souls[type] || souls.custom;
  }

  /**
   * Update current persona with partial updates
   */
  updatePersona(updates: Partial<PersonaDoc>): PersonaDoc {
    if (!this.currentPersona) {
      throw new Error('No current persona to update. Use designPersona() first.');
    }

    this.currentPersona = {
      ...this.currentPersona,
      ...updates,
      updatedAt: new Date().toISOString()
    };

    return this.currentPersona;
  }

  /**
   * Get current persona
   */
  getPersona(): PersonaDoc | null {
    return this.currentPersona;
  }

  /**
   * Get persona as JSON string
   */
  getPersonaJson(): string {
    if (!this.currentPersona) {
      return '{}';
    }
    return JSON.stringify(this.currentPersona, null, 2);
  }

  /**
   * Add memory entry to persona
   */
  addMemory(content: string, importance: number = 0.5, tags?: string[]): void {
    if (!this.currentPersona) {
      throw new Error('No current persona to add memory to.');
    }

    if (!this.currentPersona.memoryHistory) {
      this.currentPersona.memoryHistory = [];
    }

    this.currentPersona.memoryHistory.push({
      id: `memory_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      content,
      timestamp: new Date().toISOString(),
      importance,
      tags
    });

    // Keep only last 50 memories
    if (this.currentPersona.memoryHistory.length > 50) {
      this.currentPersona.memoryHistory = this.currentPersona.memoryHistory.slice(-50);
    }
  }

  /**
   * Clear memory history
   */
  clearMemory(): void {
    if (this.currentPersona) {
      this.currentPersona.memoryHistory = [];
    }
  }

  /**
   * Clone persona with new name
   */
  clone(newName: string): PersonaDoc {
    if (!this.currentPersona) {
      throw new Error('No current persona to clone.');
    }

    const cloned = { ...this.currentPersona };
    cloned.name = newName;
    cloned.description = `${newName} - ${this.currentPersona.description.split(' - ')[1] || '克隆自' + this.currentPersona.name}`;
    cloned.greeting = cloned.greeting.replace(this.currentPersona.name, newName);
    cloned.createdAt = new Date().toISOString();
    cloned.updatedAt = new Date().toISOString();
    cloned.memoryHistory = [];

    return cloned;
  }

  /**
   * Export persona for network sharing
   */
  exportForNetwork(): string {
    if (!this.currentPersona) {
      return '';
    }

    return JSON.stringify({
      name: this.currentPersona.name,
      description: this.currentPersona.description,
      capabilities: this.currentPersona.capabilities,
      interests: this.currentPersona.interests,
      personality: this.currentPersona.personality,
      greeting: this.currentPersona.greeting
    }, null, 2);
  }

  /**
   * Import persona from network
   */
  importFromNetwork(json: string): PersonaDoc {
    try {
      const data = JSON.parse(json);
      const now = new Date().toISOString();

      const persona: PersonaDoc = {
        name: data.name || 'Unknown',
        description: data.description || '',
        capabilities: data.capabilities || [],
        personality: data.personality || '',
        greeting: data.greeting || `你好！我是 ${data.name || 'Unknown'}。`,
        interests: data.interests || [],
        soul: data.soul,
        traits: data.traits,
        backstory: data.backstory,
        memoryHistory: data.memoryHistory || [],
        createdAt: now,
        updatedAt: now
      };

      return persona;
    } catch (e) {
      throw new Error(`Failed to import persona: ${e}`);
    }
  }
}

// Factory function
export function createPersonaDesignEngine(persona?: PersonaDoc): PersonaDesignEngine {
  return new PersonaDesignEngine(persona);
}

// Singleton instance
let singletonInstance: PersonaDesignEngine | null = null;

export function getPersonaDesignEngine(): PersonaDesignEngine {
  if (!singletonInstance) {
    singletonInstance = new PersonaDesignEngine();
  }
  return singletonInstance;
}