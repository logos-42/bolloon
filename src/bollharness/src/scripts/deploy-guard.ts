import * as fs from "fs";
import * as path from "path";

const PROD_IP = "47.118.31.230";
const BRIDGE_VPS_HOSTS = ["46.250.229.84"];
const GUARDED_HOSTS = [PROD_IP, ...BRIDGE_VPS_HOSTS];

const DEPLOY_SH_PATTERN = /^bash\s+scripts\/deploy\.sh(\s+--(dry-run|yes))*\s*$/;

const SSH_READONLY_CMDS = new Set([
  "journalctl", "cat", "ls", "head", "tail", "grep",
  "ss", "curl", "dig", "status", "git", "file", "stat",
]);

const SYSTEMCTL_WRITE_OPS = new Set(["restart", "stop", "start"]);

interface GuardInput {
  tool_name: string;
  tool_input: {
    command?: string;
  };
}

function getCommand(): string | null {
  try {
    const input: GuardInput = JSON.parse(fs.readFileSync(0, "utf-8"));
    return input.tool_input?.command ?? null;
  } catch {
    return null;
  }
}

function isDeploySh(cmd: string): boolean {
  return DEPLOY_SH_PATTERN.test(cmd.trim());
}

function hasGuardedHost(cmd: string): boolean {
  return GUARDED_HOSTS.some(host => cmd.includes(host));
}

function whichGuardedHost(cmd: string): string | null {
  for (const host of GUARDED_HOSTS) {
    if (cmd.includes(host)) return host;
  }
  return null;
}

function isCompoundCommand(cmd: string): boolean {
  let stripped = cmd.replace(/"[^"]*"/g, "");
  stripped = stripped.replace(/'[^']*'/g, "");
  return /[;&|]{1,2}/.test(stripped);
}

function checkScpDirection(cmd: string): "upload" | "download" | "none" {
  const parts = cmd.split(/\s+/);
  if (!parts.length || parts[0] !== "scp") return "none";

  const args = parts.slice(1).filter(p => !p.startsWith("-"));
  if (args.length < 2) return "none";

  const lastArg = args[args.length - 1];
  if (GUARDED_HOSTS.some(host => lastArg.includes(host))) {
    return "upload";
  }

  for (const arg of args.slice(0, -1)) {
    if (GUARDED_HOSTS.some(host => arg.includes(host))) {
      return "download";
    }
  }
  return "none";
}

function checkSshCommand(cmd: string): "write" | "readonly" | "none" {
  if (!cmd.includes("ssh") || !hasGuardedHost(cmd)) return "none";

  const quoted = cmd.match(/"([^"]*)"/)?.[1] ?? cmd.match(/'([^']*)'/)?.[1];
  if (!quoted) return "none";

  const remoteCmd = quoted.trim();
  const parts = remoteCmd.split(/\s+/);
  if (!parts.length) return "none";

  let idx = 0;
  if (parts[0] === "sudo") {
    idx = 1;
    while (idx < parts.length && parts[idx].startsWith("-")) {
      if (parts[idx] === "-u" && idx + 1 < parts.length) {
        idx += 2;
      } else {
        idx += 1;
      }
    }
  }

  const firstWord = parts[idx] ?? "";

  if (firstWord === "systemctl") {
    if (idx + 1 < parts.length && SYSTEMCTL_WRITE_OPS.has(parts[idx + 1])) {
      return "write";
    }
    return "readonly";
  }

  if (SSH_READONLY_CMDS.has(firstWord)) {
    return "readonly";
  }

  return "write";
}

function checkRsync(cmd: string): "write" | "dryrun" | "none" {
  if (!cmd.includes("rsync") || !hasGuardedHost(cmd)) return "none";

  const parts = cmd.split(/\s+/);
  if (parts.includes("-n") || cmd.includes("--dry-run")) {
    return "dryrun";
  }

  for (const p of parts) {
    if (p.startsWith("-") && !p.startsWith("--") && p.includes("n")) {
      return "dryrun";
    }
  }

  return "write";
}

function block(reason: string, host: string | null = null): void {
  let guidance: string;
  if (host === PROD_IP) {
    guidance = `请使用标准部署流程：
  后端: bash scripts/deploy.sh --yes
  Demo 正式: bash scripts/deploy-demo.sh <name> --channel prod --yes
  Demo 内测: bash scripts/deploy-demo.sh <name> --channel preview --yes
  Edge/Nginx: bash scripts/deploy-edge.sh --yes
详见 Bolloon.md Development Commands。`;
  } else if (BRIDGE_VPS_HOSTS.includes(host ?? "")) {
    guidance = `Bridge VPS 必须走 git pull 更新路径：
  ssh root@${host} 'sudo -u boll git -C /opt/boll pull --ff-only'
  scp/rsync 直传会重新制造 orphan worktree。
  详见 docs/issues/guard-20260408-0445-bridge-vps-orphan-worktree.md。`;
  } else {
    guidance = "未识别的受保护服务器目标，请确认 deploy 路径。";
  }

  process.stderr.write(`BLOCKED: ${reason}\n${guidance}\n`);
  process.exit(1);
}

export function main(): void {
  const cmd = getCommand();
  if (!cmd) process.exit(0);

  if (!hasGuardedHost(cmd)) process.exit(0);

  const host = whichGuardedHost(cmd);

  if (isCompoundCommand(cmd)) {
    block("检测到复合命令中包含受保护服务器操作，禁止绕过标准部署路径", host);
  }

  if (isDeploySh(cmd)) process.exit(0);

  const scpDir = checkScpDirection(cmd);
  if (scpDir === "upload") block("禁止手动 scp 上传到受保护服务器", host);
  if (scpDir === "download") process.exit(0);

  const sshType = checkSshCommand(cmd);
  if (sshType === "write") block("禁止手动对受保护服务器执行写操作", host);
  if (sshType === "readonly") process.exit(0);

  const rsyncType = checkRsync(cmd);
  if (rsyncType === "write") block("禁止手动 rsync 写入受保护服务器", host);
  if (rsyncType === "dryrun") process.exit(0);

  block("检测到未识别的受保护服务器操作", host);
}

if (require.main === module) {
  main();
}