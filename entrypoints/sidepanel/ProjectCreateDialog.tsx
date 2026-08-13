import { Globe2, LoaderCircle, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';

import { normalizeProjectOrigin } from '../../src/lib/projects/origin';

interface ProjectCreateDialogProps {
  open: boolean;
  title: string;
  description: string;
  initialValue?: string;
  submitLabel?: string;
  onClose: () => void;
  onSubmit: (origin: string) => Promise<void>;
}

export function ProjectCreateDialog({
  open,
  title,
  description,
  initialValue = '',
  submitLabel = '创建项目',
  onClose,
  onSubmit,
}: ProjectCreateDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [value, setValue] = useState(initialValue);
  const [recognizedOrigin, setRecognizedOrigin] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setValue(initialValue);
      setRecognizedOrigin('');
      setError('');
      setSubmitting(false);
      dialog.showModal();
      window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    } else if (!open && dialog.open) {
      dialog.close();
      window.setTimeout(() => returnFocusRef.current?.focus(), 0);
    }
  }, [initialValue, open]);

  const validate = () => {
    if (!value.trim()) {
      setRecognizedOrigin('');
      return;
    }
    try {
      const normalized = normalizeProjectOrigin(value);
      setRecognizedOrigin(normalized);
      setError('');
    } catch (reason) {
      setRecognizedOrigin('');
      setError(reason instanceof Error ? reason.message : '网站地址无法识别。');
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let normalized: string;
    try {
      normalized = normalizeProjectOrigin(value);
      setValue(normalized);
      setRecognizedOrigin(normalized);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '网站地址无法识别。');
      inputRef.current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(normalized);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '项目创建失败，请重试。');
      inputRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog project-create-dialog"
      aria-labelledby="project-create-title"
      aria-describedby="project-create-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting) onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="dialog-header">
          <div className="dialog-title-block">
            <span className="playful-icon dialog-icon" aria-hidden="true"><Globe2 size={20} /></span>
            <div><p className="section-kicker">网站项目</p><h2 id="project-create-title">{title}</h2></div>
          </div>
          <button type="button" className="icon-button" aria-label="关闭新建项目窗口" title="关闭" disabled={submitting} onClick={onClose}><X size={19} /></button>
        </div>
        <div className="dialog-body project-create-body">
          <p id="project-create-description" className="project-create-description">{description}</p>
          <label className={`field-label${error ? ' field-has-error' : ''}`} htmlFor="project-origin-input">
            网站地址
            <input
              ref={inputRef}
              id="project-origin-input"
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="url"
              spellCheck={false}
              value={value}
              aria-invalid={Boolean(error)}
              aria-describedby="project-origin-help project-origin-feedback"
              placeholder="例如：example.com"
              disabled={submitting}
              onChange={(event) => {
                setValue(event.target.value);
                setRecognizedOrigin('');
                if (error) setError('');
              }}
              onBlur={validate}
            />
            <span id="project-origin-help" className="field-help">可以直接输入域名。未填写协议时默认使用 HTTPS，路径和查询参数不会保存。</span>
            <span id="project-origin-feedback" className={error ? 'field-error-text project-origin-feedback' : 'project-origin-feedback'} role={error ? 'alert' : 'status'}>
              {error || (recognizedOrigin ? `将保存为 ${recognizedOrigin}` : '例如 relebook.com、www.relebook.com 或完整网址')}
            </span>
          </label>
        </div>
        <div className="dialog-footer">
          <button type="button" className="text-button" onClick={onClose} disabled={submitting}>取消</button>
          <button type="submit" className="primary-button dialog-save-button" disabled={submitting || !value.trim()}>
            {submitting ? <LoaderCircle className="spinner" size={17} /> : <Globe2 size={17} />}
            {submitting ? '正在创建' : submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
