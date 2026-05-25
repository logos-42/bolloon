export async function fetchLLMConfig() {
    const resp = await fetch('/api/llm-config');
    if (!resp.ok)
        throw new Error(`HTTP ${resp.status}`);
    return resp.json();
}
export async function saveProviderConfig(provider, config) {
    const resp = await fetch('/api/llm-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, config }),
    });
    if (!resp.ok)
        throw new Error(`HTTP ${resp.status}`);
}
export async function testProviderConnection(provider) {
    const resp = await fetch('/api/llm-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
    });
    return resp.json();
}
