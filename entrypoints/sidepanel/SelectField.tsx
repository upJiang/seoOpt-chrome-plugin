import { Check, ChevronDown } from 'lucide-react';
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  hint,
  disabled = false,
  error = false,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  hint?: string;
  disabled?: boolean;
  error?: boolean;
}) {
  const generatedId = useId();
  const id = generatedId.replace(/:/g, '');
  const listboxId = `select-listbox-${id}`;
  const hintId = hint ? `select-hint-${id}` : undefined;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<'bottom' | 'top'>('bottom');
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = options[selectedIndex] ?? options[0];

  useEffect(() => setActiveIndex(selectedIndex), [selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  const focusOption = (index: number) => {
    setActiveIndex(index);
    requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLButtonElement>(`[data-option-index="${index}"]`)?.focus();
    });
  };

  const nextEnabledIndex = (start: number, direction: 1 | -1) => {
    if (!options.length) return 0;
    let next = start;
    for (let checked = 0; checked < options.length; checked += 1) {
      next = (next + direction + options.length) % options.length;
      if (!options[next]?.disabled) return next;
    }
    return start;
  };

  const firstEnabledIndex = () => options.findIndex((option) => !option.disabled);
  const lastEnabledIndex = () => {
    for (let index = options.length - 1; index >= 0; index -= 1) {
      if (!options[index]?.disabled) return index;
    }
    return 0;
  };

  const openListbox = (index = selectedIndex) => {
    if (disabled) return;
    const triggerRect = triggerRef.current?.getBoundingClientRect();
    if (triggerRect) {
      const spaceBelow = window.innerHeight - triggerRect.bottom;
      const spaceAbove = triggerRect.top;
      setPlacement(spaceBelow < 220 && spaceAbove > spaceBelow ? 'top' : 'bottom');
    }
    setOpen(true);
    const safeIndex = options[index]?.disabled ? nextEnabledIndex(index, 1) : index;
    focusOption(safeIndex);
  };

  const choose = (option: SelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      setOpen(false);
      if (event.key === 'Escape') {
        event.preventDefault();
        triggerRef.current?.focus();
      }
      return;
    }
    let next = activeIndex;
    if (event.key === 'ArrowDown') next = nextEnabledIndex(activeIndex, 1);
    else if (event.key === 'ArrowUp') next = nextEnabledIndex(activeIndex, -1);
    else if (event.key === 'Home') next = firstEnabledIndex();
    else if (event.key === 'End') next = lastEnabledIndex();
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) choose(option);
      return;
    } else return;
    event.preventDefault();
    if (next >= 0) focusOption(next);
  };

  return (
    <div className={`select-field${error ? ' select-field-error' : ''}`} ref={rootRef}>
      <span className="select-field-label" id={`${listboxId}-label`}>{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className="select-field-trigger"
        aria-labelledby={`${listboxId}-label ${listboxId}-value`}
        aria-describedby={hintId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => open ? setOpen(false) : openListbox()}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openListbox(event.key === 'ArrowUp' ? lastEnabledIndex() : selectedIndex);
          }
        }}
      >
        <span className="select-field-value" id={`${listboxId}-value`}>{selected?.label ?? '请选择'}</span>
        <span className="select-field-icon" aria-hidden="true"><ChevronDown size={16} /></span>
      </button>
      {hint ? <span className="select-field-hint" id={hintId}>{hint}</span> : null}
      {open ? (
        <div
          className={`select-field-popover placement-${placement}`}
          id={listboxId}
          role="listbox"
          aria-labelledby={`${listboxId}-label`}
          aria-activedescendant={`${listboxId}-option-${activeIndex}`}
          onKeyDown={handleListKeyDown}
        >
          {options.map((option, index) => (
            <button
              type="button"
              id={`${listboxId}-option-${index}`}
              data-option-index={index}
              className={index === activeIndex ? 'active' : ''}
              role="option"
              aria-selected={option.value === value}
              disabled={option.disabled}
              tabIndex={index === activeIndex ? 0 : -1}
              key={option.value}
              onPointerMove={() => !option.disabled && setActiveIndex(index)}
              onClick={() => choose(option)}
            >
              <span className="select-option-copy">
                <span>{option.label}</span>
                {option.description ? <span>{option.description}</span> : null}
              </span>
              {option.value === value ? <Check size={17} aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
