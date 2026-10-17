// Side-panel extras on top of the shared quick-translate UI (popup.js):
// prefill the input with the current page selection when the panel opens.

const quickInput = document.getElementById("quick-input");

async function prefillSelection() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
    if (!tab?.id) return;
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: "get-selection-text"
    });
    if (res?.ok && res.text && quickInput && !quickInput.value) {
      quickInput.value = res.text;
    }
  } catch {
    // restricted page or no selection — leave input empty
  }
}

prefillSelection();
