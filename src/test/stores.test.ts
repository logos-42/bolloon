import { describe, it, expect, beforeEach } from 'vitest';
// #2 状态外置: store action 是纯函数, 直接单测 (不依赖 React)
import {
  transcriptStore, uiStore,
  appendMsg, replaceLastMsg, replaceMarkerMsg,
  setUiStatus, setUiThinking, setUiTransient,
} from '../cli/stores.js';

describe('stores (状态外置 #2)', () => {
  beforeEach(() => {
    transcriptStore.set([]);
    uiStore.set({ status: '', thinking: false, transient: null });
  });

  it('appendMsg 追加到末尾', () => {
    appendMsg('a'); appendMsg('b');
    expect(transcriptStore.get()).toEqual(['a', 'b']);
  });

  it('replaceLastMsg 替换末条,空则追加', () => {
    appendMsg('a'); appendMsg('b');
    replaceLastMsg('c');
    expect(transcriptStore.get()).toEqual(['a', 'c']);
    transcriptStore.set([]);
    replaceLastMsg('x');
    expect(transcriptStore.get()).toEqual(['x']);
  });

  it('replaceMarkerMsg 按内容替换,未命中不改', () => {
    appendMsg('a'); appendMsg('b');
    replaceMarkerMsg('b', 'B');
    expect(transcriptStore.get()).toEqual(['a', 'B']);
    replaceMarkerMsg('nope', 'z'); // 未命中
    expect(transcriptStore.get()).toEqual(['a', 'B']);
  });

  it('ui 域 store 各 action 独立更新', () => {
    setUiStatus('S'); expect(uiStore.get().status).toBe('S');
    setUiThinking(true); expect(uiStore.get().thinking).toBe(true);
    setUiTransient('t'); expect(uiStore.get().transient).toBe('t');
    setUiTransient(null); expect(uiStore.get().transient).toBeNull();
  });
});
