import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AGENTS } from "../../../shared/agents.mjs";
import type { AssigneeTarget } from "../types";
import { LinearIcon } from "./LinearIcon";

interface BoardSettingsMenuProps {
  showEmptyColumns: boolean;
  defaultAssigneeTarget: AssigneeTarget;
  onShowEmptyColumnsChange: (show: boolean) => void;
  onDefaultAssigneeTargetChange: (target: AssigneeTarget) => void;
}

export function BoardSettingsMenu({
  showEmptyColumns,
  defaultAssigneeTarget,
  onShowEmptyColumnsChange,
  onDefaultAssigneeTargetChange,
}: BoardSettingsMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const hasCustomSettings = showEmptyColumns || defaultAssigneeTarget !== "current-user";

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8));
    const top = trigger.bottom + 8 + menu.height <= window.innerHeight
      ? trigger.bottom + 8
      : Math.max(8, trigger.top - menu.height - 8);
    setPosition({ left, top, ready: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("[role='switch']")?.focus());

    function closeFromOutside(event: PointerEvent) {
      if (
        !menuRef.current?.contains(event.target as Node)
        && !triggerRef.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }

    function closeFromViewportChange() {
      setOpen(false);
    }

    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    window.addEventListener("blur", closeFromViewportChange);
    window.addEventListener("resize", closeFromViewportChange);
    window.addEventListener("scroll", closeFromViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
      window.removeEventListener("blur", closeFromViewportChange);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [open]);

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="board-settings-menu"
      role="dialog"
      aria-label="看板设置"
      style={{
        left: position.left,
        top: position.top,
        visibility: position.ready ? "visible" : "hidden",
      }}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          event.preventDefault();
          const controls = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role='switch'], select") ?? [])]
            .filter((control) => !(control instanceof HTMLButtonElement || control instanceof HTMLSelectElement) || !control.disabled);
          const currentIndex = controls.indexOf(document.activeElement as HTMLElement);
          const offset = event.shiftKey ? -1 : 1;
          controls[(currentIndex + offset + controls.length) % controls.length]?.focus();
        }
      }}
    >
      <section className="board-settings-section" aria-labelledby="board-options-heading">
        <h2 id="board-options-heading">看板选项</h2>
        <div className="board-setting-row">
          <span>显示空列</span>
          <button
            type="button"
            className={`board-setting-switch${showEmptyColumns ? " is-on" : ""}`}
            role="switch"
            aria-checked={showEmptyColumns}
            onClick={() => onShowEmptyColumnsChange(!showEmptyColumns)}
          >
            <span aria-hidden="true" />
            <span className="sr-only">{showEmptyColumns ? "关闭显示空列" : "开启显示空列"}</span>
          </button>
        </div>
        <label className="board-setting-row">
          <span>默认负责人</span>
          <select
            className="board-setting-select"
            aria-label="默认负责人"
            value={defaultAssigneeTarget}
            onChange={(event) => onDefaultAssigneeTargetChange(event.target.value as AssigneeTarget)}
          >
            <option value="current-user">自己</option>
            {AGENTS.map((agent) => (
              <option value={agent.assigneeTarget} key={agent.assigneeTarget}>{agent.label}</option>
            ))}
          </select>
        </label>
      </section>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`board-settings-trigger${open ? " is-open" : ""}${hasCustomSettings ? " is-active" : ""}`}
        aria-label="看板设置"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="看板设置"
        onClick={() => {
          if (!open) {
            setPosition((current) => ({ ...current, ready: false }));
          }
          setOpen((current) => !current);
        }}
      >
        <LinearIcon name="displayOptions" />
        {hasCustomSettings && <span className="board-settings-active-dot" aria-hidden="true" />}
      </button>
      {menu}
    </>
  );
}
