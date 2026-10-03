/** Skyra renders inside shadow roots. Keep its small theme/accessibility adaptation in one place. */
export function skin(node: HTMLElement) {
  let disposed = false;
  const sync = () => {
    const button = node.shadowRoot?.querySelector('button');
    if (button) { button.disabled = node.hasAttribute('disabled'); button.setAttribute('aria-label', node.textContent?.trim() || 'game control'); }
  };
  const observer = new MutationObserver(sync);
  void customElements.whenDefined(node.localName).then(async () => {
    await (node as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete;
    if (disposed || !node.shadowRoot) return;
    const style = document.createElement('style');
    style.textContent = `
      :host { font-family: Monogram, monospace !important; font-size: 24px !important; line-height: 1.1 !important; color: var(--ink) !important; }
      :host(discord-messages) { background: transparent !important; border: 0 !important; }
      :host(discord-message) { padding: 0 !important; margin: 0 !important; }
      :host(discord-message):hover { background: transparent !important; }
      .discord-message-timestamp { display: none !important; }
      .discord-message-content { padding: 0; line-height: 1.1; }
      .discord-message-body, .discord-message-markup { font: inherit !important; }
      .discord-embed-wrapper { background: var(--paper) !important; border: 0 !important; max-width: 100% !important; }
      .discord-embed-root { min-width: 0; width: 100%; }
      .discord-embed-title { font: 30px/1 Monogram, monospace !important; color: var(--ink) !important; }
      .discord-embed-image { max-width: 100% !important; max-height: 520px !important; image-rendering: pixelated; }
      .discord-embed-field-title { font: inherit !important; }
      :host(discord-button) > button, :host(discord-button) > a { font: 24px/1 Monogram, monospace !important; border: 2px solid var(--ink) !important; border-radius: 6px 9px 5px 8px !important; min-height: 40px; height: auto !important; padding: 4px 12px !important; transition: none !important; }
      button:focus-visible, a:focus-visible { outline: 3px solid #789a6e; outline-offset: 3px; }
      :host(discord-button) .success { background: #5fd82b; color: #182512; }
      :host(discord-button) .secondary { background: #b8bab3; color: #262923; }
      :host(discord-button) .disabled { opacity: .5; cursor: default !important; }
    `;
    node.shadowRoot.append(style); sync();
    observer.observe(node, { attributes: true, attributeFilter: ['disabled'], childList: true, subtree: true });
  });
  return { destroy() { disposed = true; observer.disconnect(); } };
}
