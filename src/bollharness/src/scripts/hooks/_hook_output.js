export function post_tool_use_inject(message: string): void {
  process.stdout.write(`\n\n## Hook Output\n\n${message}\n`);
}