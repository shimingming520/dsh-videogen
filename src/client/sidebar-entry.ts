/**
 * Sidebar entry injection.
 *
 * dsh's sidebar shell exposes no slot an external plugin can register into,
 * so the entry row is injected at the DOM level after the shell's New Session
 * button. A MutationObserver self-heals when React re-renders.
 */

import type { VideoGenController } from './controller.ts'
import css from './panel.module.css'

export const ENTRY_SELECTOR = '[data-dsh-videogen-entry]'

const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5h11v7h-11z"/><path d="M6.5 6.2l3.2 1.8-3.2 1.8z"/><circle cx="8" cy="8" r="0.5" fill="currentColor"/></svg>'

const FAMILY_ENTRY_SELECTOR = '[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-imagegen-entry], [data-dsh-audiogen-entry], [data-dsh-videogen-entry]'

function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

function createEntry(controller: VideoGenController, label: string, tooltip: string): HTMLButtonElement {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.dshVideogenEntry = ''
  entry.className = css.entry
  entry.setAttribute('aria-label', label)
  entry.setAttribute('title', tooltip)
  entry.innerHTML = '<span class="' + css.entryIcon + '">' + ICON + '</span><span class="' + css.entryLabel + '">' + label + '</span>'
  entry.addEventListener('click', () => { controller.toggle() })
  return entry
}

function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    const row = button.closest('[class*="logoRow"]')
    const base = (row !== null && row.parentElement === root) ? row : button
    const family = Array.from(root.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.matches(FAMILY_ENTRY_SELECTOR),
    )
    const anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling
    root.insertBefore(entry, anchor)
  }
  return true
}

export function mountSidebarEntry(controller: VideoGenController, label: string, tooltip: string): () => void {
  let entry: HTMLButtonElement | undefined
  let observer: MutationObserver | undefined

  const ensure = (): void => {
    if (entry !== undefined && entry.isConnected) return
    const root = sidebarRoot()
    if (root === undefined) return
    entry = createEntry(controller, label, tooltip)
    if (!placeEntry(root, entry)) entry = undefined
  }

  observer = new MutationObserver(() => { ensure() })
  observer.observe(document.body, { childList: true, subtree: true })
  ensure()

  return () => {
    observer?.disconnect()
    observer = undefined
    entry?.remove()
    entry = undefined
  }
}
