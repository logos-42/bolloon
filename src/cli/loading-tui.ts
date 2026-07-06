const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const CLEAR = '\x1b[2K';

const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

export class LoadingTUI {
  private write: (chunk: any, ...args: any[]) => boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor() {
    this.write = process.stdout.write.bind(process.stdout);
  }

  start(msg = 'Bolloon loading...') {
    this.running = true;
    this.write(HIDE);
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    this.timer = setInterval(() => {
      if (!this.running) return;
      this.write(`\r${CLEAR}\r  ${YELLOW}${frames[i++ % frames.length]}${RESET} ${msg}`);
    }, 100);
  }

  stop(ok = true) {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.write(`\r${CLEAR}\r`);
    if (ok) this.write(`  ${GREEN}✓${RESET} ${CYAN}Bolloon${RESET} ${GRAY}ready${RESET}\n`);
    else this.write(`  ${RED}✗${RESET} ${CYAN}Bolloon${RESET} ${GRAY}startup failed${RESET}\n`);
    this.write(SHOW);
  }
}
