import { useEffect, useRef, useState } from 'react';
import type { NcmCover, NcmMeta } from './core/ncm';
import { sniffAudioFormat } from './core/ncm';
import { startsWith } from './core/bytes';
import { decodeWithAudioContext } from './core/webAudio';
import type { CleanMode } from './core/mp3';
import { formatBytes } from './core/bytes';
import ConverterWorker from './worker?worker&inline';
import './styles.css';

type JobStatus = 'queued' | 'processing' | 'done' | 'error';

interface JobResult {
  bytes: Uint8Array;
  name: string;
  title: string;
  sourceFormat: string;
  warnings: string[];
  meta: NcmMeta | null;
}

interface Job {
  id: number;
  file: File;
  status: JobStatus;
  progress: number;
  stage: string;
  error?: string;
  result?: JobResult;
}

interface WorkerProgress {
  id: number;
  type: 'progress';
  fraction: number;
  stage: string;
}

interface WorkerDone {
  id: number;
  type: 'done';
  buffer: ArrayBuffer;
  name: string;
  title: string;
  sourceFormat: string;
  warnings: string[];
  meta: NcmMeta | null;
}

interface WorkerError {
  id: number;
  type: 'error';
  message: string;
}

interface WorkerNeedsDecode {
  id: number;
  type: 'needs-decode';
  buffer: ArrayBuffer;
  filename: string;
  sourceFormat: string;
  meta: NcmMeta | null;
  cover: NcmCover | null;
  options: { cleanMode: CleanMode; keepCover: boolean; bitrate: number };
}

type WorkerMessage = WorkerProgress | WorkerDone | WorkerError | WorkerNeedsDecode;

interface Pending {
  resolve: (result: JobResult) => void;
  reject: (error: Error) => void;
  onProgress: (fraction: number, stage: string) => void;
}

const CLEAN_MODES: Array<{ value: CleanMode; label: string; hint: string }> = [
  { value: 'artist', label: '仅人物信息', hint: '保留标题、专辑和封面' },
  { value: 'artist_album', label: '人物 + 专辑', hint: '保留标题和封面' },
  { value: 'all', label: '全部清空', hint: '只保留标题（可选封面）' },
];

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export default function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [cleanMode, setCleanMode] = useState<CleanMode>('artist');
  const [keepCover, setKeepCover] = useState(true);
  const [bitrate, setBitrate] = useState(192);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState('文件只在浏览器本地处理，不会上传到服务器。');

  const idRef = useRef(1);
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef(new Map<number, Pending>());
  const jobsRef = useRef<Job[]>([]);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  useEffect(() => {
    const worker = new ConverterWorker();
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      const pending = pendingRef.current.get(message.id);
      if (!pending) return;

      if (message.type === 'progress') {
        pending.onProgress(message.fraction, message.stage);
        return;
      }

      if (message.type === 'needs-decode') {
        pending.onProgress(0.05, '浏览器解码');
        decodeWithAudioContext(new Uint8Array(message.buffer))
          .then((pcm) => {
            worker.postMessage(
              {
                id: message.id,
                type: 'pcm',
                channels: pcm.channels,
                sampleRate: pcm.sampleRate,
                filename: message.filename,
                sourceFormat: message.sourceFormat,
                meta: message.meta,
                cover: message.cover,
                options: message.options,
              },
              pcm.channels.map((channel) => channel.buffer),
            );
          })
          .catch((error) => {
            pendingRef.current.delete(message.id);
            pending.reject(error instanceof Error ? error : new Error(String(error)));
          });
        return;
      }

      pendingRef.current.delete(message.id);
      if (message.type === 'error') {
        pending.reject(new Error(message.message));
        return;
      }

      pending.resolve({
        bytes: new Uint8Array(message.buffer),
        name: message.name,
        title: message.title,
        sourceFormat: message.sourceFormat,
        warnings: message.warnings,
        meta: message.meta,
      });
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || 'Web Worker 运行失败');
      for (const pending of pendingRef.current.values()) pending.reject(error);
      pendingRef.current.clear();
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
      pendingRef.current.clear();
    };
  }, []);

  function addFiles(fileList: FileList | File[]) {
    const accepted = Array.from(fileList).filter((file) => {
      const name = file.name.toLowerCase();
      const ext = name.slice(name.lastIndexOf('.'));
      return ['.ncm', '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.wav'].includes(ext) || file.type.startsWith('audio/');
    });
    if (!accepted.length) {
      setNotice('没有找到可处理的文件。当前支持 .ncm、.mp3、.flac。');
      return;
    }
    const next: Job[] = accepted.map((file) => ({
      id: idRef.current++,
      file,
      status: 'queued',
      progress: 0,
      stage: '等待处理',
    }));
    setJobs((current) => [...current, ...next]);
    setNotice(`已添加 ${next.length} 个文件。`);
  }

  function updateJob(id: number, patch: Partial<Job>) {
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, ...patch } : job)));
  }

  function runWorker(job: Job): Promise<JobResult> {
    return new Promise((resolve, reject) => {
      const worker = workerRef.current;
      if (!worker) {
        reject(new Error('处理线程尚未启动，请刷新页面重试'));
        return;
      }
      pendingRef.current.set(job.id, {
        resolve,
        reject,
        onProgress: (fraction, stage) => {
          updateJob(job.id, { progress: Math.max(0, Math.min(1, fraction)), stage });
        },
      });

      (async () => {
        const buffer = await job.file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const isNcm =
          job.file.name.toLowerCase().endsWith('.ncm') ||
          startsWith(bytes, [0x43, 0x54, 0x45, 0x4e, 0x46, 0x44, 0x41, 0x4d]);
        const format = isNcm ? 'ncm' : sniffAudioFormat(bytes.subarray(0, 16));

        if (!isNcm && format !== 'mp3' && format !== 'flac') {
          updateJob(job.id, { stage: '浏览器解码', progress: 0.05 });
          const pcm = await decodeWithAudioContext(bytes);
          const transfer = pcm.channels.map((channel) => channel.buffer);
          worker.postMessage(
            {
              id: job.id,
              type: 'pcm',
              channels: pcm.channels,
              sampleRate: pcm.sampleRate,
              filename: job.file.name,
              sourceFormat: format,
              options: { cleanMode, keepCover, bitrate },
            },
            transfer,
          );
          return;
        }

        worker.postMessage(
          {
            id: job.id,
            buffer,
            filename: job.file.name,
            options: { cleanMode, keepCover, bitrate },
          },
          [buffer],
        );
      })().catch((error) => {
        pendingRef.current.delete(job.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async function processAll() {
    if (busy) return;
    const queue = jobsRef.current.filter((job) => job.status === 'queued' || job.status === 'error');
    if (!queue.length) {
      setNotice('没有待处理的文件。');
      return;
    }
    setBusy(true);
    setNotice('处理中…');

    for (const job of queue) {
      updateJob(job.id, { status: 'processing', progress: 0, stage: '准备中', error: undefined });
      try {
        const result = await runWorker(job);
        updateJob(job.id, { status: 'done', progress: 1, stage: '完成', result });
      } catch (error) {
        updateJob(job.id, {
          status: 'error',
          progress: 0,
          stage: '失败',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    setBusy(false);
    setNotice('处理完成，点击每个文件的「下载 MP3」即可保存。');
  }

  function downloadOne(job: Job) {
    if (!job.result) return;
    const blob = new Blob([job.result.bytes.buffer as ArrayBuffer], { type: 'audio/mpeg' });
    downloadBlob(blob, job.result.name);
  }

  function removeJob(id: number) {
    if (busy) return;
    setJobs((current) => current.filter((job) => job.id !== id));
  }

  function clearJobs() {
    if (busy) return;
    setJobs([]);
    setNotice('列表已清空。');
  }

  const doneCount = jobs.filter((job) => job.status === 'done').length;
  const errorCount = jobs.filter((job) => job.status === 'error').length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            🐣
          </span>
          <div>
            <div className="brand-title">
              小鸡转换器 <span className="brand-badge">Web</span>
            </div>
            <div className="brand-sub">NCM 解密 · 标签清理 · 转 MP3</div>
          </div>
        </div>
        <div className="privacy">100% 本地处理</div>
      </header>

      <main>
        <section className="hero">
          <h1>把 NCM 变成能上传的 MP3</h1>
          <p>拖入网易云 .ncm 文件，自动解密、清标签、转成真 MP3；手机和电脑都能用，文件不会离开浏览器。</p>
        </section>

        <div
          className={`dropzone ${dragging ? 'dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            addFiles(event.dataTransfer.files);
          }}
          onClick={() => document.getElementById('file-input')?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') document.getElementById('file-input')?.click();
          }}
        >
          <div className="drop-icon" aria-hidden="true">
            ⬆
          </div>
          <div className="drop-title">拖入文件，或点击选择</div>
          <div className="drop-hint">支持 .ncm / .mp3 / .flac / .m4a / .aac / .ogg / .wav，可多选</div>
          <input
            id="file-input"
            type="file"
            multiple
            accept=".ncm,.mp3,.flac,.m4a,.aac,.ogg,.wav,audio/*"
            onChange={(event) => {
              if (event.target.files) addFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </div>

        <section className="panel options-panel">
          <div className="panel-head">
            <div>
              <h2>清理强度</h2>
              <p>只影响输出 MP3 的标签，不改动原始文件。</p>
            </div>
          </div>
          <div className="segmented" role="group" aria-label="清理强度">
            {CLEAN_MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                className={cleanMode === mode.value ? 'active' : ''}
                onClick={() => setCleanMode(mode.value)}
                title={mode.hint}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <div className="option-row">
            <label className="check">
              <input type="checkbox" checked={keepCover} onChange={(event) => setKeepCover(event.target.checked)} />
              <span>保留封面</span>
            </label>
            <label className="bitrate">
              <span>FLAC 转 MP3 码率</span>
              <select value={bitrate} onChange={(event) => setBitrate(Number(event.target.value))}>
                <option value={128}>128k</option>
                <option value={192}>192k</option>
                <option value={256}>256k</option>
                <option value={320}>320k</option>
              </select>
            </label>
          </div>
          <p className="fine-print">MP3 文件只清理标签，不会重新编码；FLAC 才会转码。</p>
        </section>

        <section className="panel files-panel">
          <div className="panel-head">
            <div>
              <h2>文件列表</h2>
              <p>
                {jobs.length ? `共 ${jobs.length} 个 · 完成 ${doneCount} 个${errorCount ? ` · 失败 ${errorCount} 个` : ''}` : '还没有添加文件'}
              </p>
            </div>
            <div className="panel-actions">
              <button type="button" className="ghost" onClick={clearJobs} disabled={busy || !jobs.length}>
                清空
              </button>
            </div>
          </div>

          {jobs.length === 0 ? (
            <div className="empty">拖入 NCM / MP3 / FLAC 文件后，会在这里显示处理进度。</div>
          ) : (
            <div className="file-list">
              {jobs.map((job) => (
                <article className={`file-card ${job.status}`} key={job.id}>
                  <div className="file-main">
                    <div className="file-name" title={job.file.name}>
                      {job.file.name}
                    </div>
                    <div className="file-meta">
                      <span>{formatBytes(job.file.size)}</span>
                      {job.status === 'done' && job.result ? <span>→ {job.result.name}</span> : null}
                      {job.status === 'processing' ? <span>{job.stage} {Math.round(job.progress * 100)}%</span> : null}
                      {job.status === 'queued' ? <span>等待处理</span> : null}
                      {job.status === 'error' ? <span className="error-text">失败</span> : null}
                    </div>
                    {job.status === 'error' && job.error ? <div className="error-box">{job.error}</div> : null}
                    {job.status === 'done' && job.result?.warnings.length ? (
                      <div className="warning-box">{job.result.warnings.join('；')}</div>
                    ) : null}
                    {job.status === 'processing' || job.status === 'done' ? (
                      <div className="progress-track">
                        <div className="progress-fill" style={{ width: `${Math.round(job.progress * 100)}%` }} />
                      </div>
                    ) : null}
                  </div>
                  <div className="file-actions">
                    {job.status === 'done' ? (
                      <button type="button" className="mini" onClick={() => downloadOne(job)}>
                        下载 MP3
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="close"
                      onClick={() => removeJob(job.id)}
                      disabled={busy || job.status === 'processing'}
                      aria-label="移除"
                    >
                      ×
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <div className="action-bar">
          <div className="notice">{notice}</div>
          <div className="buttons">
            <button type="button" className="primary" onClick={processAll} disabled={busy || !jobs.length}>
              {busy ? '处理中…' : '开始处理'}
            </button>
          </div>
        </div>

        <section className="tips">
          <h3>说明</h3>
          <ul>
            <li>NCM 解密和标签清理都在浏览器内完成，不会上传文件。</li>
            <li>处理完成后，点击文件右侧的「下载 MP3」即可保存，不需要打包。</li>
            <li>NCM 内的 MP3 直接清理标签；FLAC 会先解码再编码成 MP3。</li>
            <li>M4A/AAC/OGG/WAV 会交给浏览器原生解码器转成 MP3，实际支持情况取决于浏览器。</li>
            <li>第一次处理 FLAC 时需要加载 WASM 解码器，之后会走缓存。</li>
          </ul>
        </section>
      </main>

      <footer>
        小鸡转换器 Web · 本地处理 · 适配手机与桌面
      </footer>
    </div>
  );
}
