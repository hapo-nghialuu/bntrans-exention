import { READING_FEATURES, ReadingError } from "./reading-context.js";

export function createReadingFeatureApi(api, feature) {
  if (!READING_FEATURES.includes(feature))
    throw new ReadingError("source-feature");
  let generation = 0,
    disposed = false,
    captured;
  async function assertEnabled() {
    const settings = await api.settings();
    if (
      disposed ||
      settings.enabled === false ||
      settings.labFeatures?.[feature] !== true
    )
      throw new ReadingError("source-disabled");
    return settings;
  }
  const ensureCurrent = async (token) => {
    await assertEnabled();
    if (token !== generation) throw new ReadingError("source-cancelled");
  };
  async function sendCaptured(command, source, blockId, options = {}) {
    const token = generation;
    await assertEnabled();
    const tab = await api.activeTab();
    if (
      !captured ||
      tab.id !== captured.tabId ||
      source?.snapshotId !== captured.source.snapshotId ||
      tab.url !== source.url
    )
      throw new ReadingError("source-stale");
    const response = await api.sendToTab(
      "labs-reading-source",
      {
        feature,
        command,
        snapshotId: source.snapshotId,
        url: source.url,
        blockId,
        start: options.start,
        end: options.end,
        jump: options.jump === true
      },
      tab.id
    );
    await ensureCurrent(token);
    return response;
  }
  async function clear() {
    const previous = captured;
    captured = null;
    return clearSnapshot(previous);
  }
  async function clearSnapshot(previous) {
    if (!previous) return;
    try {
      await chrome.tabs.sendMessage(
        previous.tabId,
        {
          type: "labs-reading-source",
          payload: {
            feature,
            command: "clear",
            snapshotId: previous.source.snapshotId
          }
        },
        { frameId: 0 }
      );
    } catch {
      /* The target may already have navigated or closed. */
    }
  }
  const onStorage = (changes, area) => {
    if (area === "local" && changes.translatorSettings) {
      generation++;
      void clear();
    }
  };
  chrome.storage.onChanged.addListener(onStorage);
  return {
    feature,
    assertEnabled,
    async capture(mode = "selection") {
      const token = ++generation;
      await assertEnabled();
      const tab = await api.activeTab();
      await clear();
      const response = await api.sendToTab(
        "labs-reading-source",
        {
          feature,
          command: "capture",
          mode
        },
        tab.id
      );
      const next = { tabId: tab.id, source: response.source };
      try {
        await ensureCurrent(token);
      } catch (error) {
        await clearSnapshot(next);
        throw error;
      }
      if (response.source?.url !== tab.url) {
        await clearSnapshot(next);
        throw new ReadingError("source-stale");
      }
      captured = next;
      return response.source;
    },
    highlight: (source, blockId, options) =>
      sendCaptured("highlight", source, blockId, options),
    jump: (source, blockId, options) =>
      sendCaptured("jump", source, blockId, options),
    clear,
    async translate(text, options = {}) {
      if (feature === "corrections") throw new ReadingError("source-feature");
      const token = generation;
      await assertEnabled();
      let target;
      if (options.siteUrl !== "") target = await api.activeTab();
      if (captured && !Object.hasOwn(options, "siteUrl")) {
        const tab = await api.activeTab();
        if (tab.id !== captured.tabId || tab.url !== captured.source.url)
          throw new ReadingError("source-stale");
        options = { ...options, siteUrl: captured.source.url };
      }
      await ensureCurrent(token);
      const result = await api.translate(text, {
        ...options,
        labFeature: feature,
        ephemeral: true,
        skipHistory: true
      });
      await ensureCurrent(token);
      if (target) {
        const current = await api.activeTab();
        if (target.id !== current.id || target.url !== current.url)
          throw new ReadingError("source-stale");
      }
      return result;
    },
    cancel() {
      generation++;
      return clear();
    },
    dispose() {
      disposed = true;
      generation++;
      chrome.storage.onChanged.removeListener(onStorage);
      return clear();
    }
  };
}
