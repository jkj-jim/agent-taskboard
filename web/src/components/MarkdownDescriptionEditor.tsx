import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, type KeyboardEvent } from "react";

const DESCRIPTION_EXTENSIONS = [
  StarterKit.configure({
    trailingNode: false,
    link: {
      openOnClick: false,
      HTMLAttributes: {
        rel: "noreferrer",
        target: "_blank",
      },
    },
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit,
  Image.configure({ allowBase64: false }),
  Markdown.configure({
    markedOptions: { gfm: true },
  }),
];

interface MarkdownDescriptionEditorProps {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: (value: string) => void | Promise<void>;
}

export default function MarkdownDescriptionEditor({
  value,
  disabled,
  onChange,
  onCancel,
  onSave,
}: MarkdownDescriptionEditorProps) {
  const cancelingRef = useRef(false);
  const savingRef = useRef(false);
  const blurReadyRef = useRef(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const editor = useEditor({
    extensions: DESCRIPTION_EXTENSIONS,
    content: value,
    contentType: "markdown",
    editable: !disabled,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        "aria-label": "任务描述编辑器",
        class: "issue-description-document issue-description-tiptap-content",
      },
    },
    onUpdate: ({ editor: nextEditor }) => onChange(nextEditor.getMarkdown()),
    onFocus: () => {
      requestAnimationFrame(() => {
        blurReadyRef.current = true;
      });
    },
    onBlur: ({ editor: nextEditor, event }) => {
      if (!blurReadyRef.current || cancelingRef.current || savingRef.current) return;
      if (event.relatedTarget && shellRef.current?.contains(event.relatedTarget as Node)) return;
      requestSave(nextEditor.getMarkdown());
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    if (!editor || editor.getMarkdown().trim() === value.trim()) return;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    if (!editor) return;
    const frame = requestAnimationFrame(() => editor.commands.focus("end"));
    return () => cancelAnimationFrame(frame);
  }, [editor]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelingRef.current = true;
      onCancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      requestSave(editor?.getMarkdown() ?? value);
    }
  }

  function requestSave(nextValue: string) {
    if (savingRef.current) return;
    savingRef.current = true;
    void Promise.resolve()
      .then(() => onSave(nextValue))
      .catch(() => {})
      .finally(() => {
        savingRef.current = false;
      });
  }

  const empty = !value.trim();

  return (
    <div
      ref={shellRef}
      className={`issue-description-tiptap-shell${empty ? " empty" : ""}${disabled ? " is-disabled" : ""}`}
      onKeyDown={handleKeyDown}
    >
      <EditorContent editor={editor} />
    </div>
  );
}
