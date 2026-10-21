import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronRight, Folder, FolderOpen, RotateCw } from 'lucide-react';
import { api_ } from '../api';

function isWindowsDriveRoot(path: string): boolean {
  return /^[a-zA-Z]:[\\/]+$/.test(path.trim());
}

interface DirectoryPickerDialogProps {
  open: boolean;
  initialPath: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}

/**
 * Browse folders from the configured OpenCode server, not the browser host.
 * This works whether Taskboard runs beside OpenCode or on a remote server.
 */
export function DirectoryPickerDialog({
  open,
  initialPath,
  onClose,
  onSelect
}: DirectoryPickerDialogProps) {
  const [currentPath, setCurrentPath] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<{ name: string; path: string }[]>([]);
  const [drives, setDrives] = useState<{ name: string; path: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestIdRef = useRef(0);

  const loadDirectory = useCallback(async (requestedPath?: string) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError('');
    try {
      const listing = await api_.browseWorkspaceDirectories(requestedPath);
      if (requestId !== requestIdRef.current) return;
      setCurrentPath(listing.path);
      setPathInput(listing.path);
      setParentPath(listing.parentPath);
      setEntries(listing.entries);
      setDrives(listing.drives ?? []);
    } catch (err) {
      if (requestId === requestIdRef.current) {
        setError((err as Error).message || '读取目录失败');
        setEntries([]);
        setDrives([]);
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      requestIdRef.current += 1;
      return;
    }
    setPathInput(initialPath);
    void loadDirectory(initialPath.trim() || undefined);
    return () => { requestIdRef.current += 1; };
  }, [open, initialPath, loadDirectory]);

  if (!open) return null;

  const goToInputPath = (): void => {
    const target = pathInput.trim();
    if (!target) {
      setError('请先输入或选择一个目录路径。');
      return;
    }
    void loadDirectory(target);
  };

  return (
    <dialog open className="new-dialog directory-picker-dialog" aria-labelledby="directory-picker-title">
      <div className="directory-picker-header">
        <div>
          <h2 id="directory-picker-title">选择工作目录</h2>
          <p>浏览 OpenCode Server 所在环境的目录；不是浏览器所在电脑的文件系统。</p>
        </div>
        <button type="button" className="icon-btn" aria-label="关闭目录选择器" title="关闭" onClick={onClose}>×</button>
      </div>

      <div className="directory-picker-pathbar">
        <button type="button" className="btn" disabled={loading || !parentPath} title="返回上一级目录"
          onClick={() => { if (parentPath) void loadDirectory(parentPath); }}>
          <ArrowUp size={13} /> 上级
        </button>
        <input aria-label="当前目录路径" value={pathInput} onChange={e => setPathInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); goToInputPath(); } }}
          placeholder="输入服务器上的绝对路径" />
        <button type="button" className="btn" disabled={loading || !pathInput.trim()} onClick={goToInputPath}>打开</button>
        <button type="button" className="icon-btn" disabled={loading} title="刷新目录"
          onClick={() => void loadDirectory(currentPath || undefined)}><RotateCw size={14} /></button>
      </div>

      <div className="directory-picker-current" title={currentPath}>
        <FolderOpen size={14} />
        <span>{currentPath || '正在读取当前目录…'}</span>
      </div>

      {isWindowsDriveRoot(currentPath) && (
        <div className="directory-picker-drives" aria-label="Windows 磁盘切换">
          <span className="directory-picker-drives-title">可用磁盘</span>
          {drives.length ? (
            <div className="directory-picker-drives-list">
              {drives.map(drive => (
                <button type="button" key={drive.path}
                  className={`directory-picker-drive${drive.path.replace(/[\\/]+$/, '').toLowerCase() === currentPath.replace(/[\\/]+$/, '').toLowerCase() ? ' active' : ''}`}
                  title={drive.path} onClick={() => void loadDirectory(drive.path)}>
                  <FolderOpen size={14} />
                  <span>{drive.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="directory-picker-drives-empty">没有探测到其它可用盘符。你仍可以在上方输入框直接输入路径，例如 C:\\。</p>
          )}
        </div>
      )}

      {error && <div className="directory-picker-error" role="alert">
        <strong>读取目录失败</strong>
        <span>{error}</span>
        <small>请检查服务端部署配置、网络连通性，以及 OpenCode Server 是否支持 GET /file 接口。也可以直接输入目录路径后重试。</small>
      </div>}

      <div className="directory-picker-list" aria-label="子目录列表">
        {loading ? (
          <div className="directory-picker-state">正在读取目录…</div>
        ) : !error && entries.length === 0 ? (
          <div className="directory-picker-state">当前目录没有可浏览的子目录。</div>
        ) : !error ? entries.map(entry => (
          <button type="button" key={entry.path} className="directory-picker-entry"
            title={entry.path} onClick={() => void loadDirectory(entry.path)}>
            <Folder size={14} />
            <span>{entry.name}</span>
            <small>{entry.path}</small>
            <ChevronRight size={14} />
          </button>
        )) : null}
      </div>

      <div className="directory-picker-footer">
        <span>确认后会保存完整路径，后续任务由该 OpenCode Server 访问此目录。</span>
        <menu>
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="button" className="btn primary" disabled={loading || !currentPath}
            onClick={() => { onSelect(currentPath); onClose(); }}>选择当前目录</button>
        </menu>
      </div>
    </dialog>
  );
}
