export interface RunCommandParams {
  command: string;
  adapter?: string;
  timeout?: number;
}

export async function runCommand(params: RunCommandParams): Promise<{ success: boolean; output: string; error?: string }> {
  return {
    success: false,
    output: '',
    error: 'OpenCLI is a command-line tool and should be invoked via shell command: opencli <command>',
  };
}