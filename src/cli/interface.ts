import * as readline from 'readline';
import { documentReader } from '../documents/reader.js';
import { getMinimax } from '../constraints/index.js';
import { AgentProtocol } from '../agents/protocol.js';
import { p2pNetwork, P2PNode } from '../network/p2p.js';

export class CLIInterface {
  private agent: AgentProtocol | null = null;
  private localNode: P2PNode | null = null;
  private rl: readline.Interface;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  async start(): Promise<void> {
    console.log('\n🤖 AI文档智能体 P2P 网络');
    console.log('========================\n');

    await this.initP2PNode();
    await this.initLLM();
    this.initAgent();

    this.showHelp();
    await this.runLoop();
  }

  private async initP2PNode(): Promise<void> {
    console.log('初始化P2P节点...');

    const bootstrapPeers = process.env.BOOTSTRAP_PEERS?.split(',');

    this.localNode = await p2pNetwork.createNode({ bootstrapPeers });

    console.log(`节点已启动!`);
    console.log(`Peer ID: ${this.localNode.peerId}`);
    console.log(`地址: ${this.localNode.multiaddrs.join(', ')}\n`);

    this.syncOfflineMessages();
  }

  private async initLLM(): Promise<void> {
    const apiKey = process.env.MINIMAX_API_KEY;

    if (!apiKey) {
      console.warn('⚠️  MINIMAX_API_KEY 未设置，摘要功能将使用模拟模式');
      return;
    }

    getMinimax();
    console.log('LLM已初始化\n');
  }

  private initAgent(): void {
    if (!this.localNode) throw new Error('P2P node not initialized');
    this.agent = new AgentProtocol(this.localNode.peerId);
    console.log('Agent协议已初始化\n');
  }

  private async syncOfflineMessages(): Promise<void> {
    if (!this.localNode) return;

    const messages = p2pNetwork.getOfflineMessages(this.localNode.peerId);
    for (const msg of messages) {
      const messageStr = new TextDecoder().decode(msg);
      const [type, ...payloadParts] = messageStr.split(':');
      console.log(`📬 收到离线消息 [${type}]: ${payloadParts.join(':')}`);
    }
  }

  private showHelp(): void {
    console.log('\n可用命令:');
    console.log('  read <file>     - 读取并处理文档');
    console.log('  peers           - 显示已连接的对等节点');
    console.log('  send <peer>     - 向指定节点发送消息');
    console.log('  broadcast       - 广播任务到所有节点');
    console.log('  summary <text>  - 总结文本');
    console.log('  help            - 显示帮助');
    console.log('  exit            - 退出\n');
  }

  private async runLoop(): Promise<void> {
    while (true) {
      const input = await this.prompt('> ');

      if (!input) continue;

      const [cmd, ...args] = input.trim().split(/\s+/);

      try {
        switch (cmd.toLowerCase()) {
          case 'read':
            await this.handleRead(args[0]);
            break;
          case 'peers':
            this.handlePeers();
            break;
          case 'send':
            await this.handleSend(args[0]);
            break;
          case 'broadcast':
            await this.handleBroadcast();
            break;
          case 'summary':
            await this.handleSummary(args.join(' '));
            break;
          case 'help':
            this.showHelp();
            break;
          case 'exit':
            await this.shutdown();
            return;
          default:
            console.log('未知命令，输入 help 查看可用命令');
        }
      } catch (e) {
        console.error('错误:', e);
      }
    }
  }

  private prompt(question: string): Promise<string> {
    return new Promise(resolve => {
      this.rl.question(question, resolve);
    });
  }

  private async handleRead(filePath?: string): Promise<void> {
    if (!filePath) {
      console.log('请提供文件路径: read <file>');
      return;
    }

    console.log(`📄 读取文档: ${filePath}`);
    const content = await documentReader.read(filePath);
    console.log(`文档大小: ${content.metadata.size} 字节`);
    console.log(`内容预览: ${content.text.substring(0, 200)}...\n`);

    const llm = getMinimax();
    const chunks = documentReader.chunk(content.text);
    const summaries: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      console.log(`处理块 ${i + 1}/${chunks.length}...`);
      const result = await llm.summarize(chunks[i]);
      summaries.push(result.summary);

      if (result.qualityScore >= 0.7) {
        console.log(`  ✅ 质量评分: ${(result.qualityScore * 10).toFixed(1)}/10`);
      } else {
        console.log(`  ⚠️ 质量评分: ${(result.qualityScore * 10).toFixed(1)}/10, 需要审核`);
      }
    }

    console.log('\n📝 生成的摘要:');
    console.log(summaries.join('\n\n'));
  }

  private handlePeers(): void {
    const peers = p2pNetwork.getPeers();
    if (peers.length === 0) {
      console.log('当前无连接的对等节点');
    } else {
      console.log('已连接节点:');
      for (const peer of peers) {
        console.log(`  - ${peer}`);
      }
    }
  }

  private async handleSend(peerId?: string): Promise<void> {
    if (!peerId) {
      console.log('请提供目标节点ID: send <peer-id>');
      return;
    }

    const message = await this.prompt('输入消息: ');
    await p2pNetwork.sendMessage(peerId, 'message', message);
    console.log('消息已发送');
  }

  private async handleBroadcast(): Promise<void> {
    const message = await this.prompt('输入广播消息: ');
    await p2pNetwork.broadcast('message', message);
    console.log('广播已发送');
  }

  private async handleSummary(text: string): Promise<void> {
    if (!text) {
      console.log('请提供要总结的文本: summary <text>');
      return;
    }

    const llm = getMinimax();
    const result = await llm.summarize(text);

    console.log('\n📝 摘要结果:');
    console.log(result.summary);
    console.log(`\n质量评分: ${(result.qualityScore * 10).toFixed(1)}/10`);
  }

  private async shutdown(): Promise<void> {
    console.log('\n正在关闭...');
    await p2pNetwork.shutdown();
    this.rl.close();
    console.log('已退出');
  }
}