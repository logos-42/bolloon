/**
 * StartupVerifier - 启动自检验证器
 * 在服务启动时验证所有关键组件
 */

import type { StartupReport, StartupCheck } from './types.js';

export class StartupVerifier {
  private checks: Map<string, StartupCheck> = new Map();

  /**
   * 添加检查项
   */
  addCheck(name: string): void {
    this.checks.set(name, { name, status: 'pending' });
  }

  /**
   * 标记检查开始
   */
  startCheck(name: string): void {
    const check = this.checks.get(name);
    if (check) {
      check.status = 'running';
      check.startTime = Date.now();
    }
  }

  /**
   * 标记检查完成
   */
  completeCheck(name: string, passed: boolean, message?: string): void {
    const check = this.checks.get(name);
    if (check) {
      check.status = passed ? 'passed' : 'failed';
      check.message = message;
      check.duration_ms = Date.now() - (check.startTime || Date.now());
    }
  }

  /**
   * 运行所有自检
   */
  async verify(): Promise<StartupReport> {
    const startTime = Date.now();
    const critical_failures: string[] = [];

    // 1. 检查 Node.js 版本
    this.addCheck('node_version');
    this.startCheck('node_version');
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.replace('v', '').split('.')[0], 10);
    if (majorVersion >= 18) {
      this.completeCheck('node_version', true, `Node.js ${nodeVersion}`);
    } else {
      this.completeCheck('node_version', false, `Node.js ${nodeVersion} too old, need >= 18`);
      critical_failures.push('Node.js version too old');
    }

    // 2. 检查必要目录
    this.addCheck('required_directories');
    this.startCheck('required_directories');
    try {
      const fs = await import('fs/promises');
      const paths = [
        process.env.HOME ? `${process.env.HOME}/.bolloon` : '/tmp/.bolloon',
        '/tmp'
      ];
      for (const p of paths) {
        await fs.access(p);
      }
      this.completeCheck('required_directories', true, 'All required directories accessible');
    } catch (err: any) {
      this.completeCheck('required_directories', false, err.message);
      critical_failures.push('Cannot access required directories');
    }

    // 3. 检查 LLM 配置
    this.addCheck('llm_config');
    this.startCheck('llm_config');
    const hasLlmKey = !!(
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.MINIMAX_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.OLLAMA_BASE_URL
    );
    if (hasLlmKey) {
      this.completeCheck('llm_config', true, 'LLM API key found');
    } else {
      this.completeCheck('llm_config', false, 'No LLM API key configured (optional)');
      // LLM 配置不是致命的，只是警告
    }

    // 4. 检查 P2P 依赖
    this.addCheck('p2p_modules');
    this.startCheck('p2p_modules');
    try {
      await import('@diap/sdk');
      this.completeCheck('p2p_modules', true, '@diap/sdk available');
    } catch (err: any) {
      this.completeCheck('p2p_modules', false, `@diap/sdk not available: ${err.message}`);
      critical_failures.push('@diap/sdk module not found');
    }

    // 5. 检查 IPFS 连接
    this.addCheck('ipfs_connection');
    this.startCheck('ipfs_connection');
    try {
      const ipfsRes = await fetch('http://127.0.0.1:5001/api/v0/id', {
        method: 'POST',
        signal: AbortSignal.timeout(3000)
      });
      if (ipfsRes.ok) {
        this.completeCheck('ipfs_connection', true, 'IPFS local node accessible');
      } else {
        this.completeCheck('ipfs_connection', false, 'IPFS returned error');
      }
    } catch (err: any) {
      this.completeCheck('ipfs_connection', false, 'IPFS not accessible (optional)');
    }

    // 6. 检查内存
    this.addCheck('memory');
    this.startCheck('memory');
    const usage = process.memoryUsage();
    const heapPercent = (usage.heapUsed / usage.heapTotal) * 100;
    if (heapPercent < 90) {
      this.completeCheck('memory', true, `Heap usage ${heapPercent.toFixed(1)}%`);
    } else {
      this.completeCheck('memory', false, `Heap usage critical: ${heapPercent.toFixed(1)}%`);
      critical_failures.push('Memory usage too high at startup');
    }

    // 7. 检查网络
    this.addCheck('network');
    this.startCheck('network');
    try {
      const res = await fetch('https://www.google.com/generate_204', {
        signal: AbortSignal.timeout(5000)
      });
      this.completeCheck('network', true, 'Internet connection available');
    } catch {
      this.completeCheck('network', false, 'No internet connection (optional)');
    }

    const totalDuration = Date.now() - startTime;

    return {
      success: critical_failures.length === 0,
      checks: Array.from(this.checks.values()),
      total_duration_ms: totalDuration,
      critical_failures
    };
  }

  /**
   * 打印检查报告
   */
  printReport(report: StartupReport): void {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚀 Bolloon 启动自检报告');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    for (const check of report.checks) {
      const icon = check.status === 'passed' ? '✅' :
                   check.status === 'failed' ? '❌' :
                   check.status === 'running' ? '⏳' : '⭕';
      const duration = check.duration_ms ? ` (${check.duration_ms}ms)` : '';
      console.log(`  ${icon} ${check.name}${duration}`);
      if (check.message) {
        console.log(`     ${check.message}`);
      }
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`总计耗时: ${report.total_duration_ms}ms`);

    if (report.success) {
      console.log('✅ 所有关键检查通过！');
    } else {
      console.log('❌ 关键检查失败:');
      for (const failure of report.critical_failures) {
        console.log(`   · ${failure}`);
      }
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  }

  /**
   * 快速验证（不打印）
   */
  async quickCheck(): Promise<boolean> {
    const report = await this.verify();
    return report.success;
  }

  /**
   * 获取检查状态
   */
  getChecks(): StartupCheck[] {
    return Array.from(this.checks.values());
  }
}

// 导出便捷函数
let startupVerifierInstance: StartupVerifier | null = null;

export async function runStartupVerification(): Promise<StartupReport> {
  const verifier = new StartupVerifier();
  startupVerifierInstance = verifier;
  const report = await verifier.verify();
  verifier.printReport(report);
  return report;
}

export function getStartupVerifier(): StartupVerifier {
  if (!startupVerifierInstance) {
    startupVerifierInstance = new StartupVerifier();
  }
  return startupVerifierInstance;
}