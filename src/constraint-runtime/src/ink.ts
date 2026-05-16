export function renderMarkdownPanel(text: string): string {
  const border = '='.repeat(40);
  return `${border}\n${text}\n${border}`;
}
