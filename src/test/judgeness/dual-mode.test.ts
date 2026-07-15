import { describe, it, expect } from 'vitest';
import { negotiateAudience, dualRender, descriptionToJsonLd, descriptionToHumanHtml, descriptionToHumanHtml as _d } from '../../web/util/dual-mode.js';

describe('web/util/dual-mode — Accept 协商', () => {
  it('default = agent (LD-JSON)', () => {
    expect(negotiateAudience({})).toBe('agent');
  });

  it('Accept: text/html → human', () => {
    expect(negotiateAudience({ accept: 'text/html' })).toBe('human');
    expect(negotiateAudience({ accept: 'text/html,application/ld+json' })).toBe('agent'); // 显式包含 LD-JSON 优先
  });

  it('?view=human → human', () => {
    expect(negotiateAudience({ query: { view: 'human' } })).toBe('human');
  });

  it('user-agent 含 bot → agent', () => {
    expect(negotiateAudience({ userAgent: 'Mozilla/5.0 (compatible; MyBot/1.0)' })).toBe('agent');
  });

  it('dualRender 返回 JSON-LD when audience=agent', () => {
    const r = dualRender(
      {},
      () => '<h1>hi</h1>',
      () => ({ '@context': 'x', '@type': 'Y' })
    );
    expect(r.contentType).toContain('application/ld+json');
    expect(r.body).toContain('"@type"');
  });

  it('dualRender 返回 HTML when audience=human', () => {
    const r = dualRender(
      { query: { view: 'human' } },
      () => '<h1>human</h1>',
      () => []
    );
    expect(r.contentType).toContain('text/html');
    expect(r.body).toContain('<h1>');
  });

  it('descriptionToJsonLd 含 @context', () => {
    const e = descriptionToJsonLd({
      descriptionId: 'jd-x',
      judgmentRef: 'hv-x',
      visibility: 'public',
      openState: 'open',
    } as any);
    expect(e['@context']).toContain('judgeness.bolloon.com');
    expect(e['@type']).toBe('JudgenessDescription');
  });

  it('descriptionToHumanHtml escapes XSS payload', () => {
    const html = descriptionToHumanHtml({
      descriptionId: 'jd-xss',
      judgmentRef: '"><img src=x>',
      visibility: 'public',
      openState: 'open',
    } as any);
    // 应该 escape 了 <
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  void _d;
});
