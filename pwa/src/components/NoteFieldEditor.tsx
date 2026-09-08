"use client";

import { useEffect, useRef, useState } from "react";
import { storeMedia } from "@/lib/db/client";
import { editorHtml } from "@/lib/editor-html";

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
  const fileInput = useRef<HTMLInputElement>(null);
  const savedRange = useRef<Range | null>(null);
  const [notice, setNotice] = useState("");
  const [formats, setFormats] = useState({ bold: false, italic: false, underline: false });
  const [mediaBusy, setMediaBusy] = useState(false);
  const [sourceMode, setSourceMode] = useState(false);

  useEffect(() => {
    const element = editor.current;
    if (element && element.innerHTML !== value) {
      element.innerHTML = editorHtml(value);
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
    onChange(element.textContent?.trim() || element.querySelector("img, audio, video") ? element.innerHTML : "");
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

  function insertLink() {
    const url = window.prompt("Link address (https://…):");
    if (!url) return;
    if (!/^(https?:|mailto:)/i.test(url.trim())) {
      setNotice("Links must start with https://, http://, or mailto:.");
      return;
    }
    command("createLink", url.trim());
  }

  async function insertMedia(files: FileList | File[]) {
    if (disabled || mediaBusy) return;
    const selected = [...files].filter((file) => /^(image|audio|video)\//.test(file.type));
    if (!selected.length) { setNotice("Choose an image, audio, or video file."); return; }
    setMediaBusy(true);
    setNotice("");
    try {
      for (const file of selected) {
        const filename = await storeMedia(file.name, await file.arrayBuffer());
        const source = encodeURIComponent(filename);
        const html = file.type.startsWith("image/") ? `<img src="${source}" alt="">`
          : file.type.startsWith("audio/") ? `[sound:${filename}]`
            : `<video src="${source}" controls></video>`;
        command("insertHTML", html);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Media could not be added.");
    } finally {
      setMediaBusy(false);
    }
  }

  return (
    <div className="field-editor">
      <label id={`${id}-label`} htmlFor={id}>{label}</label>
      <div className="note-editor">
        <div className="note-editor-toolbar" role="group" aria-label={`${label} formatting`}>
          <button type="button" disabled={disabled || mediaBusy} title="Undo (Ctrl/⌘+Z)" onMouseDown={(event) => event.preventDefault()} onClick={() => command("undo")}>↶</button>
          <button type="button" disabled={disabled || mediaBusy} title="Redo (Ctrl/⌘+Shift+Z)" onMouseDown={(event) => event.preventDefault()} onClick={() => command("redo")}>↷</button>
          {(["bold", "italic", "underline"] as const).map((format) => (
            <button key={format} type="button" disabled={disabled} aria-label={format[0].toUpperCase() + format.slice(1)}
              aria-pressed={formats[format]} title={`${format[0].toUpperCase() + format.slice(1)} (Ctrl/⌘+${format[0].toUpperCase()})`}
              onMouseDown={(event) => event.preventDefault()} onClick={() => command(format)}>
              {format === "bold" ? <strong>B</strong> : format === "italic" ? <em>I</em> : <u>U</u>}
            </button>
          ))}
          <button type="button" disabled={disabled || mediaBusy} title="Strikethrough" onMouseDown={(event) => event.preventDefault()} onClick={() => command("strikeThrough")}><s>S</s></button>
          <button type="button" disabled={disabled || mediaBusy} title="Superscript" onMouseDown={(event) => event.preventDefault()} onClick={() => command("superscript")}>x<sup>2</sup></button>
          <button type="button" disabled={disabled || mediaBusy} title="Subscript" onMouseDown={(event) => event.preventDefault()} onClick={() => command("subscript")}>x<sub>2</sub></button>
          <button type="button" disabled={disabled || mediaBusy} title="Bulleted list" onMouseDown={(event) => event.preventDefault()} onClick={() => command("insertUnorderedList")}>•≡</button>
          <button type="button" disabled={disabled || mediaBusy} title="Numbered list" onMouseDown={(event) => event.preventDefault()} onClick={() => command("insertOrderedList")}>1≡</button>
          <select className="note-editor-block" disabled={disabled || mediaBusy} aria-label="Text block style" defaultValue="" onChange={(event) => {
            if (event.target.value) command("formatBlock", event.target.value);
            event.target.value = "";
          }}>
            <option value="">Text style</option><option value="p">Paragraph</option><option value="h2">Heading</option><option value="h3">Subheading</option><option value="blockquote">Quote</option><option value="pre">Code block</option>
          </select>
          <button type="button" disabled={disabled || mediaBusy} title="Align left" onMouseDown={(event) => event.preventDefault()} onClick={() => command("justifyLeft")}>≡</button>
          <button type="button" disabled={disabled || mediaBusy} title="Align center" onMouseDown={(event) => event.preventDefault()} onClick={() => command("justifyCenter")}>≡</button>
          <button type="button" disabled={disabled || mediaBusy} title="Align right" onMouseDown={(event) => event.preventDefault()} onClick={() => command("justifyRight")}>≡</button>
          <button type="button" disabled={disabled || mediaBusy} title="Indent" onMouseDown={(event) => event.preventDefault()} onClick={() => command("indent")}>↳</button>
          <button type="button" disabled={disabled || mediaBusy} title="Outdent" onMouseDown={(event) => event.preventDefault()} onClick={() => command("outdent")}>↲</button>
          <button type="button" disabled={disabled || mediaBusy} title="Insert table" onMouseDown={(event) => event.preventDefault()} onClick={() => command("insertHTML", "<table><tbody><tr><td>Cell</td><td>Cell</td></tr><tr><td>Cell</td><td>Cell</td></tr></tbody></table><br>")}>▦</button>
          <button type="button" disabled={disabled || mediaBusy} title="Add link" onMouseDown={(event) => event.preventDefault()} onClick={insertLink}>↗</button>
          <button type="button" disabled={disabled || mediaBusy} title="Remove formatting" onMouseDown={(event) => event.preventDefault()} onClick={() => command("removeFormat")}>Tx</button>
          <button type="button" disabled={disabled || mediaBusy} aria-pressed={sourceMode} title="Edit HTML source" onMouseDown={(event) => event.preventDefault()} onClick={() => {
            if (sourceMode) onChange(editorHtml(value));
            setSourceMode((current) => !current);
          }}>{"</>"}</button>
          <label className="note-editor-color" title="Text color"><span>●</span><input type="color" disabled={disabled || mediaBusy} aria-label="Text color" onChange={(event) => command("foreColor", event.target.value)} /></label>
          <label className="note-editor-color note-editor-highlight" title="Highlight color"><span>●</span><input type="color" disabled={disabled || mediaBusy} aria-label="Highlight color" onChange={(event) => command("hiliteColor", event.target.value)} /></label>
          {clozeNumber !== undefined && <button className="cloze-button" type="button" disabled={disabled}
            title="Hide selected text (Ctrl/⌘+Shift+C)" onMouseDown={(event) => event.preventDefault()} onClick={insertCloze}>Cloze</button>}
          <button className="note-editor-media-button" type="button" disabled={disabled || mediaBusy} title="Insert media" onMouseDown={(event) => event.preventDefault()} onClick={() => fileInput.current?.click()}>{mediaBusy ? "…" : "Media"}</button>
          <input ref={fileInput} className="sr-only" type="file" multiple accept="image/*,audio/*,video/*" onChange={(event) => {
            if (event.target.files) void insertMedia(event.target.files);
            event.target.value = "";
          }} />
        </div>
        {sourceMode ? <textarea id={id} className="note-editor-source" value={value} disabled={disabled} spellCheck={false}
          aria-labelledby={`${id}-label`} aria-describedby={notice ? `${id}-notice` : undefined}
          onChange={(event) => onChange(editorHtml(event.target.value))} /> : <div ref={editor} id={id} className="note-editor-content" contentEditable={!disabled} suppressContentEditableWarning
          role="textbox" aria-multiline="true" aria-labelledby={`${id}-label`} aria-disabled={disabled}
          aria-describedby={notice ? `${id}-notice` : undefined} onInput={publish} onBlur={publish}
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
            const files = [...event.clipboardData.files];
            if (files.length) { void insertMedia(files); return; }
            const html = event.clipboardData.getData("text/html");
            command("insertHTML", html ? editorHtml(html) : event.clipboardData.getData("text/plain"));
          }}
          onDrop={(event) => { event.preventDefault(); if (event.dataTransfer.files.length) void insertMedia(event.dataTransfer.files); }} />}
      </div>
      {notice && <p id={`${id}-notice`} className="note-editor-notice" role="status">{notice}</p>}
    </div>
  );
}
