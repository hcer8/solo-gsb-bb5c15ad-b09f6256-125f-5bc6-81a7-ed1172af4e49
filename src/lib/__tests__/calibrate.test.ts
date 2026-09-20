import { describe, expect, it } from 'vitest';
import { applyMapper, buildMapper, findAnchors, SLOPE_MAX, SLOPE_MIN } from '../calibrate';
import type { Cue } from '../srt';

const cue = (id: number, start: number, end: number, text: string): Cue => ({
  id,
  start,
  end,
  text,
});

const TEXTS = [
  '我们曾经一起走过那条长长的河堤',
  '风吹过芦苇像有人在低声说话',
  '你说总有一天要离开这座小城',
  '我以为那只是玩笑话而已',
  '直到站台上只剩下我一个人的影子',
  '火车开走的时候天正下着小雨',
];

/** 构造与 TEXTS 一一对应的字幕序列，可整体平移 shift 毫秒。 */
const makeCues = (texts: string[], shift = 0, t0 = 10_000, dur = 2_000, gap = 1_000): Cue[] =>
  texts.map((text, i) =>
    cue(i, t0 + i * (dur + gap) + shift, t0 + i * (dur + gap) + dur + shift, text),
  );

describe('findAnchors', () => {
  it('整体平移的版本：全部配对成功且偏移一致', () => {
    const a = makeCues(TEXTS);
    const b = makeCues(TEXTS, 5_000);
    const anchors = findAnchors(a, b);
    expect(anchors).toHaveLength(TEXTS.length);
    expect(anchors.every((x) => x.dropped === null)).toBe(true);
    for (const x of anchors) expect(x.offset).toBe(5_000);
  });

  it('顺序冲突的配对被剔除', () => {
    const a = makeCues(['你好世界今天天气真不错', '独自一人走在漫长的街道上']);
    // B 中文本顺序颠倒（B[0] 对应 A[1]，B[1] 对应 A[0]）
    const b = [
      cue(0, 10_000, 12_000, '独自一人走在漫长的街道上'),
      cue(1, 13_000, 15_000, '你好世界今天天气真不错'),
    ];
    const anchors = findAnchors(a, b);
    expect(anchors).toHaveLength(2);
    expect(anchors.filter((x) => x.dropped === 'order')).toHaveLength(1);
    expect(anchors.filter((x) => x.dropped === null)).toHaveLength(1);
  });

  it('异常偏移的锚点被剔除', () => {
    const a = makeCues(TEXTS);
    const b = makeCues(TEXTS, 5_000);
    // 把其中一条的时间再推后 60 秒（文本不变）→ 偏移 65s 成为异常值
    b[4] = { ...b[4], start: b[4].start + 60_000, end: b[4].end + 60_000 };
    const anchors = findAnchors(a, b);
    expect(anchors.find((x) => x.bIdx === 4)?.dropped).toBe('outlier');
    expect(anchors.filter((x) => x.dropped === null)).toHaveLength(TEXTS.length - 1);
  });

  it('超出最大偏移的配对不成为候选', () => {
    const a = makeCues(TEXTS);
    const b = makeCues(TEXTS, 300_000); // 平移 5 分钟 > 默认 2 分钟窗口
    expect(findAnchors(a, b)).toHaveLength(0);
    // 放宽窗口后能找到
    expect(findAnchors(a, b, { maxOffsetMs: 600_000 })).toHaveLength(TEXTS.length);
  });

  it('空输入安全', () => {
    expect(findAnchors([], [])).toEqual([]);
    expect(findAnchors(makeCues(TEXTS), [])).toEqual([]);
    expect(findAnchors([], makeCues(TEXTS))).toEqual([]);
  });
});

describe('buildMapper', () => {
  it('两个锚点：段内线性插值，首尾按最近区段斜率外推', () => {
    const f = buildMapper([
      { bMid: 10_000, aMid: 5_000 },
      { bMid: 20_000, aMid: 14_000 },
    ]);
    // 段斜率 0.9，段界 15000
    expect(f(10_000)).toBe(5_000);
    expect(f(20_000)).toBe(14_000);
    expect(f(12_000)).toBe(6_800);
    expect(f(0)).toBe(-4_000); // 首段斜率外推
    expect(f(30_000)).toBe(23_000); // 末段斜率外推
  });

  it('多个锚点形成多个区段', () => {
    const f = buildMapper([
      { bMid: 0, aMid: 0 },
      { bMid: 10_000, aMid: 10_000 },
      { bMid: 20_000, aMid: 30_000 },
    ]);
    // 段0 斜率 1（界 5000），段1 斜率 2（界 15000）
    expect(f(2_000)).toBe(2_000);
    expect(f(12_000)).toBe(14_000);
    expect(f(25_000)).toBe(40_000);
  });

  it('极端斜率被钳制到 [SLOPE_MIN, SLOPE_MAX]', () => {
    const steep = buildMapper([
      { bMid: 0, aMid: 0 },
      { bMid: 1_000, aMid: 100_000 },
    ]);
    expect(steep(500)).toBe(500 * SLOPE_MAX);
    const flat = buildMapper([
      { bMid: 0, aMid: 0 },
      { bMid: 100_000, aMid: 100 },
    ]);
    expect(flat(100_000)).toBe(100_000 * SLOPE_MIN);
  });

  it('单锚点退化为恒定平移，零锚点为恒等映射', () => {
    const f = buildMapper([{ bMid: 10_000, aMid: 4_000 }]);
    expect(f(10_000)).toBe(4_000);
    expect(f(99_000)).toBe(93_000);
    const id = buildMapper([]);
    expect(id(12_345)).toBe(12_345);
  });

  it('禁用部分锚点后映射随之改变（即时重算）', () => {
    const all = [
      { bMid: 0, aMid: 0 },
      { bMid: 10_000, aMid: 5_000 },
      { bMid: 20_000, aMid: 20_000 },
    ];
    const withMid = buildMapper(all);
    const withoutMid = buildMapper([all[0], all[2]]);
    expect(withMid(10_000)).toBe(5_000);
    expect(withoutMid(10_000)).toBe(10_000);
  });
});

describe('applyMapper', () => {
  it('整体平移端到端：校准后时间与 A 完全一致', () => {
    const a = makeCues(TEXTS);
    const b = makeCues(TEXTS, 5_000);
    const anchors = findAnchors(a, b).filter((x) => x.dropped === null);
    const cal = applyMapper(b, buildMapper(anchors));
    cal.forEach((c, i) => {
      expect(c.start).toBe(a[i].start);
      expect(c.end).toBe(a[i].end);
      expect(c.text).toBe(a[i].text);
    });
  });

  it('倒转映射也被修正为单调且时长为正', () => {
    const cues = [cue(0, 0, 100, '一'), cue(1, 200, 300, '二'), cue(2, 400, 500, '三')];
    const cal = applyMapper(cues, (t) => 1_000 - t);
    for (let i = 0; i < cal.length; i++) {
      expect(cal[i].end).toBeGreaterThan(cal[i].start);
      if (i > 0) {
        expect(cal[i].start).toBeGreaterThanOrEqual(cal[i - 1].start);
        expect(cal[i].end).toBeGreaterThanOrEqual(cal[i - 1].end);
      }
    }
  });

  it('映射结果不为负，文本与 id 保持不变', () => {
    const cues = [cue(7, 0, 100, '负值测试')];
    const cal = applyMapper(cues, (t) => t - 10_000);
    expect(cal[0].start).toBe(0);
    expect(cal[0].end).toBeGreaterThan(cal[0].start);
    expect(cal[0].text).toBe('负值测试');
    expect(cal[0].id).toBe(7);
  });
});
