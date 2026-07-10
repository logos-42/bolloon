const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const CLEAR = '\x1b[2K';

const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

export type LoadingStepStatus = 'pending' | 'active' | 'ok' | 'warn' | 'error';

export interface LoadingStep {
  label: string;
  status: LoadingStepStatus;
}

const STEP_SYMBOL: Record<LoadingStepStatus, string> = {
  pending: `${GRAY}○${RESET}`,
  active: `${YELLOW}⠹${RESET}`,
  ok: `${GREEN}✓${RESET}`,
  warn: `${YELLOW}⚠${RESET}`,
  error: `${RED}✗${RESET}`,
};

export class LoadingTUI {
  private write: (chunk: any, ...args: any[]) => boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private frameIdx = 0;
  private steps: LoadingStep[] = [];
  private currentLabel = 'Bolloon loading...';
  private lastRenderedStepCount = 0;
  private finished = false;
  private ok = true;

  constructor() {
    this.write = process.stdout.write.bind(process.stdout);
  }

  setSteps(steps: string[]) {
    this.steps = steps.map(label => ({ label, status: 'pending' as LoadingStepStatus }));
    this.drawAll();
  }

  startStep(index: number, label?: string) {
    if (index < 0 || index >= this.steps.length) return;
    this.steps[index].status = 'active';
    if (label !== undefined) this.steps[index].label = label;
    this.drawAll();
  }

  completeStep(index: number, status: LoadingStepStatus = 'ok', label?: string) {
    if (index < 0 || index >= this.steps.length) return;
    this.steps[index].status = status;
    if (label !== undefined) this.steps[index].label = label;
    this.drawAll();
  }

  setMessage(msg: string) {
    this.currentLabel = msg;
  }

  start(msg = 'Bolloon loading...') {
    if (this.timer) return;
    this.currentLabel = msg;
    this.write(HIDE);
    this.timer = setInterval(() => {
      if (this.finished) return;
      this.write(`\r${CLEAR}\r  ${YELLOW}${this.frames[this.frameIdx++ % this.frames.length]}${RESET} ${this.currentLabel}`);
    }, 100);
  }

  private drawAll() {
    if (!this.timer || this.finished) return;
    const out: string[] = [];
    for (const step of this.steps) {
      const prefix = step.status === 'active' ? YELLOW : '';
      out.push(`  ${STEP_SYMBOL[step.status]} ${prefix}${step.label}${RESET}\n`);
    }
    this.lastRenderedStepCount = this.steps.length;
    this.write(out.join(''));
    this.write(`\x1b[${this.steps.length}A`);
    this.write(`\r${CLEAR}\r  ${YELLOW}${this.frames[this.frameIdx % this.frames.length]}${RESET} ${this.currentLabel}`);
  }

  stop(ok = true) {
    this.finished = true;
    this.ok = ok;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.lastRenderedStepCount > 0) {
      this.write(`\x1b[${this.lastRenderedStepCount}B`);
    }
    this.write(`\r${CLEAR}\r`);
    if (this.steps.length > 0) {
      for (const step of this.steps) {
        this.write(`  ${STEP_SYMBOL[step.status]} ${step.label}\n`);
      }
    }
    if (this.ok) {
      this.write(`  ${GREEN}✓${RESET} ${CYAN}Bolloon${RESET} ${GRAY}ready${RESET}\n`);
    } else {
      this.write(`  ${RED}✗${RESET} ${CYAN}Bolloon${RESET} ${GRAY}startup failed${RESET}\n`);
    }
    this.write(SHOW);
  }

  isFinished() {
    return this.finished;
  }

  wasOk() {
    return this.ok;
  }
}
