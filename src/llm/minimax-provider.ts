export interface ChatOptions {
  model: string;
  messages: { role: string; content: string; sender_name?: string; sender_type?: string }[];
  temperature: number;
}

export interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  base_resp?: { status_msg?: string };
}

export interface MiniMaxProvider {
  chat(options: ChatOptions): Promise<ChatResponse>;
  chatPro(options: ChatOptions): Promise<ChatResponse>;
}

export class MinimaxProvider {
  private apiKey: string;
  private baseUrl = 'https://api.minimax.chat/v1';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const response = await fetch(`${this.baseUrl}/text/chatcompletion_v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(options)
    });

    if (!response.ok) {
      throw new Error(`Minimax API error: ${response.status}`);
    }

    return response.json() as ChatResponse;
  }

  async chatPro(options: ChatOptions): Promise<ChatResponse> {
    const response = await fetch(`${this.baseUrl}/text/chatcompletion_pro`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(options)
    });

    if (!response.ok) {
      throw new Error(`Minimax API error: ${response.status}`);
    }

    return response.json() as ChatResponse;
  }
}

let providerInstance: MiniMaxProvider | null = null;

export function initMinimaxProvider(apiKey: string): MiniMaxProvider {
  providerInstance = new MinimaxProvider(apiKey);
  return providerInstance;
}

export function getMinimaxProvider(): MiniMaxProvider {
  if (!providerInstance) {
    throw new Error('Minimax provider not initialized. Call initMinimaxProvider first.');
  }
  return providerInstance;
}