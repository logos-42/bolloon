import { describe, it, expect } from 'vitest';
import {
  validateFrameBeforeSend,
  listHearthKinds,
  type HearthAnyFrame,
} from '../../judgeness/protocol.js';

describe('judgeness protocol — 4 kind + 硬约束', () => {
  it('list 4 kind', () => {
    const k = listHearthKinds();
    expect(k).toEqual([
      'hearth_description_publish',
      'hearth_description_query',
      'hearth_autoadd_invite',
      'hearth_block',
    ]);
  });

  it('hearth_description_publish: descriptionId 必填', () => {
    const f: HearthAnyFrame = {
      kind: 'hearth_description_publish',
      payload: {
        publishId: 'p1',
        fromNodeId: 'a',
        descriptionId: '',
        visibility: 'public',
        ts: Date.now(),
      },
    };
    expect(() => validateFrameBeforeSend(f)).toThrow();
  });

  it('hearth_autoadd_invite: visibility=private 拒绝', () => {
    const f: HearthAnyFrame = {
      kind: 'hearth_autoadd_invite',
      payload: {
        inviteId: 'i1',
        fromNodeId: 'a',
        channelTopic: 'c',
        visibility: 'private',
        ts: Date.now(),
      },
    };
    expect(() => validateFrameBeforeSend(f)).toThrow();
  });

  it('hearth_block: targetNodeId === fromNodeId 拒绝', () => {
    const f: HearthAnyFrame = {
      kind: 'hearth_block',
      payload: {
        blockId: 'b1',
        fromNodeId: 'a',
        targetNodeId: 'a',
        ts: Date.now(),
      },
    };
    expect(() => validateFrameBeforeSend(f)).toThrow();
  });

  it('合规帧通过', () => {
    const f: HearthAnyFrame = {
      kind: 'hearth_description_publish',
      payload: {
        publishId: 'p2',
        fromNodeId: 'a',
        descriptionId: 'jd-ok',
        visibility: 'allowlist',
        ts: Date.now(),
      },
    };
    expect(() => validateFrameBeforeSend(f)).not.toThrow();
  });
});
