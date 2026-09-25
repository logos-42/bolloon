/**
 * update-cli.ts — 更新系统的**脚本侧入口** (2026-09-19)
 *
 * 为什么单独有它: `scripts/version_check.py` / `scripts/upgrade.sh` / 安装脚本 / pre-commit
 * 都不想拉起整个 CLI (那会先跑 setup 门禁、banner、TUI 冻结那一套)。它们只需要
 * **同一份版本解析与同一份检查逻辑**, 所以这里只暴露薄薄一层:
 *
 *   node dist/utils/update-cli.js check   [json] [force] [offline]
 *   node dist/utils/update-cli.js status  [json]
 *   node dist/utils/update-cli.js plan    [json]
 *   node dist/utils/update-cli.js history [json] [N]
 *   node dist/utils/update-cli.js version [json] [verbose]
 *   node dist/utils/update-cli.js doctor  [json] [offline]
 *
 * 退出码与 `bolloon update` 完全一致: 0 正常 / 1 执行失败 / 2 检查不可用。
 */

import { resolveBolloonHome } from '../setup/setup-store.js';
import { checkForUpdate, readUpdateStatus, checkExitCode } from './update-manager.js';
import { renderCheckResult, renderStatusReport, runDoctorCommand, runUpdateCommand, runVersionCommand, parseChannelArg } from '../cli/update-commands.js';
import { runDoctor, renderDoctor } from './update-health.js';

function out(s: string) { process.stdout.write(s + '\n'); }

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'check';
  const args = argv.slice(1);
  const json = args.includes('json') || args.includes('--json');
  const home = resolveBolloonHome();
  // 双源: `--channel stable|dev` 只覆盖本次进程 (§12.2); 给了不认识的值就直接拒
  const ch = parseChannelArg(args);
  if (ch.error) {
    process.stderr.write(`✗ ${ch.error}\n`);
    return 2;
  }

  switch (cmd) {
    case 'check': {
      const force = args.includes('force') || args.includes('--force') || args.includes('--fresh') || !!ch.channel;
      const offline = args.includes('offline') || args.includes('--offline');
      const r = await checkForUpdate({ home, force, offline, channel: ch.channel });
      if (json) out(JSON.stringify(r, null, 2));
      else if (r.status === 'up_to_date' || r.status === 'check_skipped') {
        // 脚本默认静默: 只有在"有话说"时才输出 (与 AGENTS.md §1 步 0 的约定一致)
        if (process.env.BOLLOON_UPDATE_VERBOSE === '1') out(renderCheckResult(r));
      } else {
        out(renderCheckResult(r));
      }
      return checkExitCode(r.status);
    }
    case 'status': {
      const s = await readUpdateStatus({ home, channel: ch.channel });
      if (json) out(JSON.stringify(s, null, 2));
      else out(renderStatusReport(s));
      return 0;
    }
    case 'plan': return runUpdateCommand(['plan', ...(ch.channel ? ['--channel', ch.channel] : []), ...(json ? ['json'] : [])]);
    case 'history': return runUpdateCommand(['history', ...args.filter((a) => /^\d+$/.test(a)), ...(json ? ['json'] : [])]);
    case 'version': return runVersionCommand(args);
    case 'doctor': {
      if (json) return runDoctorCommand(['json', ...args.filter((a) => a === 'offline' || a === '--offline')]);
      const rep = await runDoctor({ bolloonHome: home, skipNetwork: args.includes('offline') || args.includes('--offline') });
      out(renderDoctor(rep));
      return rep.grade === 'failed' ? 1 : 0;
    }
    default:
      process.stderr.write(`未知子命令: ${cmd}\n用法: update-cli check|status|plan|history|version|doctor [json] [--channel stable|dev]\n`);
      return 64;
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(`更新命令执行失败: ${e?.message || e}\n`);
  process.exit(1);
});
