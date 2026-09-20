import { useMemo, useState } from 'react';
import {
  applyMapper,
  buildMapper,
  findAnchors,
  type Anchor,
  type CalibOptions,
} from '../lib/calibrate';
import { formatTimecode, type Cue } from '../lib/srt';

const PAGE = 60;

/** 锚点的稳定标识（参数变化重算后仍指向同一对字幕） */
const keyOf = (a: Anchor) => `${a.aIdx}-${a.bIdx}`;

const fmtSignedS = (v: number) => `${v >= 0 ? '+' : '−'}${(Math.abs(v) / 1000).toFixed(2)}s`;
const fmtSignedMs = (v: number) => `${v >= 0 ? '+' : '−'}${Math.round(Math.abs(v))}ms`;

interface CalibratePanelProps {
  nameA: string;
  nameB: string;
  cuesA: Cue[];
  /** 原始版本 B（校准始终基于原始时间轴计算） */
  cuesB: Cue[];
  options: CalibOptions;
  onOptions(next: CalibOptions): void;
  /** 被手动禁用的锚点 key 集合 */
  disabled: ReadonlySet<string>;
  onToggle(key: string): void;
  /** 应用校准（传入映射后的 B）并进入顺序对齐 */
  onApply(cues: Cue[]): void;
  /** 不做校准，直接用原始 B 对齐 */
  onSkip(): void;
  onBack(): void;
}

export function CalibratePanel(props: CalibratePanelProps) {
  const { cuesA, cuesB, options, disabled } = props;
  const [shown, setShown] = useState(PAGE);

  const anchors = useMemo(() => findAnchors(cuesA, cuesB, options), [cuesA, cuesB, options]);
  const enabled = useMemo(
    () => anchors.filter((a) => a.dropped === null && !disabled.has(keyOf(a))),
    [anchors, disabled],
  );
  const mapper = useMemo(() => buildMapper(enabled), [enabled]);
  const calibrated = useMemo(() => applyMapper(cuesB, mapper), [cuesB, mapper]);

  const stats = useMemo(() => {
    let sum = 0;
    let max = 0;
    for (const a of enabled) {
      const r = Math.abs(mapper(a.bMid) - a.aMid);
      sum += r;
      if (r > max) max = r;
    }
    return {
      total: anchors.length,
      enabled: enabled.length,
      orderDropped: anchors.filter((a) => a.dropped === 'order').length,
      outlierDropped: anchors.filter((a) => a.dropped === 'outlier').length,
      avgRes: enabled.length > 0 ? sum / enabled.length : 0,
      maxRes: max,
    };
  }, [anchors, enabled, mapper]);

  const setOpt = (patch: Partial<CalibOptions>) => props.onOptions({ ...options, ...patch });
  const parseNum = (raw: string, fallback: number, lo: number, hi: number) => {
    const v = Number(raw);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  };

  return (
    <section className="import calib-panel">
      <div className="calib-intro">
        <h2>时间轴校准</h2>
        <p>
          自动从两侧文本筛选高相似锚点，剔除顺序冲突与异常偏移后，用至少两个锚点对版本 B
          的时间做分段线性映射（首尾按最近区段斜率外推，映射后保证时间单调且时长为正）。
          禁用 / 启用锚点会即时重算；只有点击「应用校准并对齐」才会替换对齐输入。
        </p>
      </div>

      <div className="wrap-settings">
        <label>
          最小相似度
          <input
            type="number"
            min={0.5}
            max={1}
            step={0.05}
            value={options.minSim}
            onChange={(e) => setOpt({ minSim: parseNum(e.target.value, options.minSim, 0.5, 1) })}
          />
        </label>
        <label>
          最大偏移（秒）
          <input
            type="number"
            min={1}
            max={600}
            step={1}
            value={options.maxOffsetMs / 1000}
            onChange={(e) =>
              setOpt({ maxOffsetMs: Math.round(parseNum(e.target.value, options.maxOffsetMs / 1000, 1, 600) * 1000) })
            }
          />
        </label>
        <span className="spacer" />
        <span className="file-chip a">{props.nameA}</span>
        <span className="swap">⇄</span>
        <span className="file-chip b">{props.nameB}</span>
        <button className="btn sm" onClick={props.onBack}>
          返回导入
        </button>
      </div>

      <div className="wrap-summary">
        候选锚点 {stats.total} · 启用 {stats.enabled} · 顺序冲突剔除 {stats.orderDropped} · 异常偏移剔除{' '}
        {stats.outlierDropped}
        {stats.enabled > 0 && (
          <>
            {' '}
            · 平均残差 {fmtSignedMs(stats.avgRes)} · 最大残差 {fmtSignedMs(stats.maxRes)}
          </>
        )}
        {stats.enabled < 2 && <em> · 至少需要 2 个启用锚点才能应用校准</em>}
        <span className="wrap-hint">
          偏移 = B 中点 − A 中点；残差 = 映射后 B 中点 − A 中点
        </span>
      </div>

      <div className="calib-list">
        {anchors.length === 0 && (
          <div className="empty">
            当前参数下没有找到高相似锚点，可降低最小相似度或增大最大偏移；也可以直接跳过校准。
          </div>
        )}
        {anchors.slice(0, shown).map((a) => {
          const key = keyOf(a);
          const isDisabled = disabled.has(key);
          const active = a.dropped === null && !isDisabled;
          const newMid = mapper(a.bMid);
          const residual = newMid - a.aMid;
          const status = a.dropped === 'order'
            ? '顺序冲突'
            : a.dropped === 'outlier'
              ? '异常偏移'
              : active
                ? '启用'
                : '已禁用';
          const statusCls = a.dropped !== null ? 'warn' : active ? 'ok' : 'dim';
          return (
            <article className={`calib-entry ${active ? '' : 'off'}`} key={key}>
              <div className="we-head">
                <span className={`tag ${statusCls}`}>{status}</span>
                <span className="g-idx">
                  A#{a.aIdx + 1} ↔ B#{a.bIdx + 1}
                </span>
                <span className="tag dim">相似度 {Math.round(a.sim * 100)}%</span>
                <span className="cue-time">A 中点 {formatTimecode(a.aMid)}</span>
                <span className="cue-time">
                  B 原 {formatTimecode(a.bMid)} → 新 {formatTimecode(newMid)}
                </span>
                <span className="tag dim">偏移 {fmtSignedS(a.offset)}</span>
                <span className={`tag ${Math.abs(residual) > 500 ? 'low' : 'dim'}`}>
                  残差 {fmtSignedMs(residual)}
                </span>
                <span className="spacer" />
                {a.dropped === null && (
                  <button className="btn sm" onClick={() => props.onToggle(key)}>
                    {isDisabled ? '启用' : '禁用'}
                  </button>
                )}
              </div>
              <div className="calib-texts">
                <div className="calib-text a" title={a.aText}>
                  A：{a.aText}
                </div>
                <div className="calib-text b" title={a.bText}>
                  B：{a.bText}
                </div>
              </div>
            </article>
          );
        })}
        {anchors.length > shown && (
          <button className="btn more" onClick={() => setShown((v) => v + PAGE)}>
            显示更多（剩余 {anchors.length - shown} 个锚点）
          </button>
        )}
      </div>

      <div className="import-actions">
        <button
          className="btn primary lg"
          disabled={stats.enabled < 2}
          title={stats.enabled < 2 ? '至少需要 2 个启用锚点' : '用校准后的版本 B 进入顺序对齐'}
          onClick={() => props.onApply(calibrated)}
        >
          应用校准并对齐
        </button>
        <button className="btn ghost lg" onClick={props.onSkip}>
          不校准，直接对齐
        </button>
        <span className="hint">
          应用后版本 B 将使用校准后的时间轴进入顺序对齐；对齐结果页可一键恢复原始 B 时间。
        </span>
      </div>
    </section>
  );
}
