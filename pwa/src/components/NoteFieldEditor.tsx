"use client";

import { useEffect, useRef, useState } from "react";

export function NoteFieldEditor({ id, label, value, onChange, clozeNumber, autoFocus, disabled }: {
  id: string;
  label: string;
  value: string;
  onChange: (html: string) => void;
  clozeNumber?: number;
  autoFocus?: boolean;
  disabled: boolean;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const [notice, setNotice] = useState("");
  const [formats, setFormats] = useState({ bold: false, italic: false, underline: false });

  useEffect(() => {
    const element = editor.current;
    if (element && element.innerHTML !== value) {
      element.innerHTML = value;
      savedRange.current = null;
    }
  }, [value]);

  useEffect(() => {
    if (autoFocus) editor.current?.focus();
    const rememberSelection = () => {
      const selection = window.getSelection();
      if (!selection?.rangeCount || !editor.current) return;
      const range = selection.getRangeAt(0);
      if (editor.current.contains(range.commonAncestorContainer)) {
        savedRange.current = range.cloneRange();
        setFormats({
          bold: document.queryCommandState("bold"),
          italic: document.queryCommandState("italic"),
          underline: document.queryCommandState("underline"),
        });
      }
    };
    document.addEventListener("selectionchange", rememberSelection);
    return () => document.removeEventListener("selectionchange", rememberSelection);
  }, [autoFocus]);

  function publish() {
    const element = editor.current;
    if (!element) return;
    onChange(element.textContent?.trim() ? element.innerHTML : "");
  }

  function restoreSelection() {
    const element = editor.current;
    if (!element || disabled) return null;
    element.focus();
    const selection = window.getSelection();
    if (!selection) return null;
    const range = savedRange.current;
    if (range && element.contains(range.commonAncestorContainer)) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return selection;
  }

  function command(name: string, content?: string) {
    if (!restoreSelection()) return;
    // Native editing commands keep formatting and insertions in the browser's undo history.
    const applied = document.execCommand(name, false, content);
    setNotice(applied ? "" : "This editing action is unavailable in this browser.");
    const selection = window.getSelection();
    if (selection?.rangeCount) savedRange.current = selection.getRangeAt(0).cloneRange();
    setFormats({
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      underline: document.queryCommandState("underline"),
    });
    publish();
  }

  function insertCloze() {
    const selection = restoreSelection();
    if (!selection || !selection.rangeCount || clozeNumber === undefined) return;
    const range = selection.getRangeAt(0);
    if (selection.isCollapsed || !selection.toString().trim()) {
      setNotice("Select the text you want to hide first.");
      return;
    }
    const fragment = document.createElement("div");
    fragment.append(range.cloneContents());
    command("insertHTML", `{{c${clozeNumber}::${fragment.innerHTML}}}`);
  }

  return (
    <div className="field-editor">
      <label id={`${id}-label`} htmlFor={id}>{label}</label>
      <div className="note-editor">
        <div className="note-editor-toolbar" role="group" aria-label={`${label} formatting`}>
          {(["bold", "italic", "underline"] as const).map((format) => (
            <button key={format} type="button" disabled={disabled} aria-label={format[0].toUpperCase() + format.slice(1)}
              aria-pressed={formats[format]} title={`${format[0].toUpperCase() + format.slice(1)} (Ctrl/⌘+${format[0].toUpperCase()})`}
              onMouseDown={(event) => event.preventDefault()} onClick={() => command(format)}>
              {format === "bold" ? <strong>B</strong> : format === "italic" ? <em>I</em> : <u>U</u>}
            </button>
          ))}
          {clozeNumber !== undefined && <button className="cloze-button" type="button" disabled={disabled}
            title="Hide selected text (Ctrl/⌘+Shift+C)" onMouseDown={(event) => event.preventDefault()} onClick={insertCloze}>Cloze</button>}
        </div>
        <div ref={editor} id={id} className="note-editor-content" contentEditable={!disabled} suppressContentEditableWarning
          role="textbox" aria-multiline="true" aria-labelledby={`${id}-label`} aria-disabled={disabled}
          aria-describedby={notice ? `${id}-notice` : undefined} onInput={publish}
          onKeyDown={(event) => {
            if (!(event.ctrlKey || event.metaKey)) return;
            const key = event.key.toLowerCase();
            if (key === "c" && event.shiftKey && clozeNumber !== undefined) {
              event.preventDefault();
              insertCloze();
            } else if (!event.shiftKey && ["b", "i", "u"].includes(key)) {
              event.preventDefault();
              command(key === "b" ? "bold" : key === "i" ? "italic" : "underline");
            }
          }}
          onPaste={(event) => {
            event.preventDefault();
            command("insertText", event.clipboardData.getData("text/plain"));
          }}
          onDrop={(event) => event.preventDefault()} />
      </div>
      {notice && <p id={`${id}-notice`} className="note-editor-notice" role="status">{notice}</p>}
    </div>
  );
}
