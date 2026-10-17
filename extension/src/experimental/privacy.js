import {
  providerDestination,
  endpoint,
  assertDestination,
  assertProvider
} from "../common/privacy-policy.js";

export async function mount(container, api) {
  const settings = await api.settings();
  const controller = new AbortController();
  const signal = controller.signal;
  const t = api.t;
  const panel = document.createElement("section");
  panel.className = "lab-panel";
  const node = (tag, text = "") => {
    const el = document.createElement(tag);
    el.textContent = text;
    return el;
  };
  const heading = node(
    "h2",
    t(
      "Website privacy — experimental",
      "Quyền riêng tư theo website — thử nghiệm"
    )
  );
  panel.append(
    heading,
    node(
      "p",
      t(
        "Local-only permits Chrome Built-in AI and strict loopback endpoints only. Built-in models may require an initial browser download. Local speech requires an installed local OS voice. Ask mode rejects page requests until confirmed in extension UI for that action.",
        "Local-only chỉ cho Chrome Built-in AI và endpoint loopback. Model built-in có thể cần trình duyệt tải lần đầu. Đọc cục bộ cần giọng OS đã cài. Chế độ Hỏi trước chặn yêu cầu từ trang; phải xác nhận từng thao tác trong UI extension."
      )
    )
  );
  function field(label, input) {
    panel.append(api.field(label, input));
    return input;
  }
  function checkbox(label, checked) {
    const input = node("input");
    input.type = "checkbox";
    input.checked = checked;
    return field(label, input);
  }
  function select(values, value) {
    const el = node("select");
    for (const [key, label] of values) {
      const option = node("option", label);
      option.value = key;
      el.append(option);
    }
    el.value = value;
    return el;
  }
  const modes = [
    ["cloud", t("Cloud allowed", "Cho phép cloud")],
    ["local-only", "Local-only"],
    ["ask", t("Ask before cloud", "Hỏi trước khi gửi cloud")]
  ];
  const enabled = checkbox(
    t(
      "Enable website profiles (off by default)",
      "Bật profile website (mặc định tắt)"
    ),
    settings.labFeatures?.privacy === true
  );
  const defaultMode = field(
    t("Default profile", "Profile mặc định"),
    select(modes, settings.privacyDefaultMode || "cloud")
  );
  const selectedProvider = () =>
    (settings.providers || []).find((p) => p.id === settings.activeProviderId);
  function describeDestination(provider, mode, allowedDestinations) {
    if (!provider) return t("No configured provider", "Chưa cấu hình provider");
    try {
      const destination = providerDestination(provider);
      if (mode === "ask" && !destination.local) {
        assertProvider({ mode: "cloud", allowedDestinations }, provider);
        return `${provider.name || provider.type} → ${destination.origin} · ${t(
          "confirm each action in extension UI",
          "xác nhận từng thao tác trong UI extension"
        )}`;
      }
      assertProvider(
        { mode, allowedDestinations, cloudConsent: false },
        provider
      );
      return `${provider.name || provider.type} → ${destination.origin} · ${t(
        "permitted",
        "được phép"
      )}`;
    } catch (error) {
      return `${provider.name || provider.type} → ${
        error.destination || t("invalid endpoint", "endpoint không hợp lệ")
      } · ${t("blocked", "bị chặn")}`;
    }
  }
  function describeSpeech(mode, allowedDestinations) {
    const label = t("Speech", "Đọc");
    if (mode === "local-only" || settings.activeTTSProviderId === "local")
      return `${label} → ${t("local OS voice", "giọng OS cục bộ")}`;
    const template =
      settings.ttsProviders?.find((p) => p.id === settings.activeTTSProviderId)
        ?.url || "https://translate.google.com/translate_tts";
    try {
      const origin = endpoint(
        template
          .replaceAll("{text}", "")
          .replaceAll("{lang}", "en")
          .replaceAll("{speed}", "1")
      ).origin;
      assertDestination(
        { mode: mode === "ask" ? "cloud" : mode, allowedDestinations },
        origin
      );
      return `${label} → ${origin} · ${
        mode === "ask"
          ? t("confirm each action", "xác nhận từng thao tác")
          : t("permitted", "được phép")
      }`;
    } catch (error) {
      return `${label} → ${
        error.destination || t("invalid endpoint", "endpoint không hợp lệ")
      } · ${t("blocked", "bị chặn")}`;
    }
  }
  const screenshotProvider = () =>
    (settings.providers || []).find(
      (p) => p.id === settings.screenshotProviderId
    );
  function describeRoutes(provider, mode, allowedDestinations, ruleProviderId) {
    const image = ruleProviderId ? provider : screenshotProvider();
    return [
      describeDestination(provider, mode, allowedDestinations),
      image && image.id !== provider?.id
        ? `${t("Screenshot", "Ảnh")}: ${describeDestination(image, mode, allowedDestinations)}`
        : "",
      describeSpeech(mode, allowedDestinations)
    ]
      .filter(Boolean)
      .join(" | ");
  }
  const defaultDestination = node("p");
  defaultDestination.className = "lab-result";
  const updateDefaultDestination = () => {
    defaultDestination.textContent = describeRoutes(
      selectedProvider(),
      defaultMode.value
    );
  };
  defaultMode.addEventListener("change", updateDefaultDestination, { signal });
  updateDefaultDestination();
  panel.append(defaultDestination);
  const fallback = checkbox(
    t(
      "Explicitly allow Google fallback when policy permits (sends the text to Google after a failure)",
      "Đồng ý fallback Google khi policy cho phép (gửi nội dung sang Google sau lỗi)"
    ),
    settings.allowCloudFallback === true
  );
  const history = checkbox(
    t("Keep local translation history", "Lưu lịch sử dịch cục bộ"),
    settings.historyEnabled !== false
  );
  const cache = checkbox(
    t("Keep local translation cache", "Lưu cache dịch cục bộ"),
    settings.cacheEnabled !== false
  );
  function ttl(label, value) {
    const input = node("input");
    input.type = "number";
    input.min = "1";
    input.max = "8760";
    input.value = String(value);
    return field(label, input);
  }
  const historyTTL = ttl(
    t("History expiry (hours)", "Hạn lưu lịch sử (giờ)"),
    settings.historyTTLHours ?? 720
  );
  const cacheTTL = ttl(
    t("Cache expiry (hours)", "Hạn lưu cache (giờ)"),
    settings.cacheTTLHours ?? 168
  );
  panel.append(
    node(
      "h3",
      t(
        "Rules: exact hostname and its subdomains; most specific wins",
        "Rule: hostname và subdomain; ưu tiên rule cụ thể nhất"
      )
    )
  );
  const list = node("div");
  list.className = "lab-list";
  panel.append(list);
  const rows = [];
  const providers = [
    ["", t("Use selected provider", "Dùng provider đang chọn")],
    ...(settings.providers || []).map((p) => {
      let destination;
      try {
        destination = providerDestination(p).origin;
      } catch {
        destination = t("Invalid endpoint", "Endpoint không hợp lệ");
      }
      return [p.id, `${p.name || p.type} → ${destination}`];
    })
  ];
  function button(label, action, parent = panel) {
    const el = node("button", label);
    el.type = "button";
    el.addEventListener(
      "click",
      async () => {
        el.disabled = true;
        try {
          await action();
        } catch (e) {
          api.status(String(e.message || e), "error");
        } finally {
          el.disabled = false;
        }
      },
      { signal }
    );
    parent.append(el);
    return el;
  }
  function addRule(rule = {}) {
    const card = node("div");
    card.className = "lab-card";
    const host = node("input");
    host.value = rule.hostname || "";
    host.placeholder = "work.example.com";
    const mode = select(modes, rule.mode || "local-only");
    const provider = select(providers, rule.providerId || "");
    const destinations = node("input");
    destinations.value = (rule.allowedDestinations || []).join(", ");
    destinations.placeholder = "http://localhost:11434, https://api.openai.com";
    card.append(
      api.field(t("Hostname", "Hostname"), host),
      api.field(t("Profile", "Profile"), mode),
      api.field(
        t(
          "Provider and actual destination",
          "Provider và đích dữ liệu thực tế"
        ),
        provider
      ),
      api.field(
        t(
          "Allowed origins, comma separated (empty = any permitted by profile)",
          "Đích origin được phép, cách bởi dấu phẩy (trống = theo profile)"
        ),
        destinations
      )
    );
    const preview = node("p");
    preview.className = "lab-result";
    const updatePreview = () => {
      const selected =
        (settings.providers || []).find((p) => p.id === provider.value) ||
        selectedProvider();
      const allowed = destinations.value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      preview.textContent = describeRoutes(
        selected,
        mode.value,
        allowed.length ? allowed : undefined,
        provider.value
      );
    };
    for (const input of [provider, mode, destinations])
      input.addEventListener("change", updatePreview, { signal });
    updatePreview();
    card.append(preview);
    const row = { card, host, mode, provider, destinations };
    button(
      t("Remove rule", "Xóa rule"),
      () => {
        rows.splice(rows.indexOf(row), 1);
        card.remove();
      },
      card
    );
    rows.push(row);
    list.append(card);
  }
  for (const rule of settings.privacyRules || []) addRule(rule);
  button(t("Add hostname rule", "Thêm rule hostname"), () => addRule());
  const warning = node("p");
  warning.className = "lab-result";
  const showWarning = () => {
    warning.textContent = t(
      "Saving a Cloud profile permits content to leave the device. Fallback is separate opt-in. Disabling retention deletes stored data; incognito requests never read/write cache/history. Destination checks cannot audit what a permitted server does with data.",
      "Lưu profile Cloud cho phép nội dung rời máy. Fallback cần đồng ý riêng. Tắt lưu trữ sẽ xóa dữ liệu đã lưu; yêu cầu ẩn danh không đọc/ghi cache và lịch sử. Kiểm tra đích không thể kiểm toán cách server được phép sử dụng dữ liệu."
    );
  };
  defaultMode.addEventListener("change", showWarning, { signal });
  showWarning();
  panel.append(warning);
  button(t("Save privacy settings", "Lưu quyền riêng tư"), async () => {
    const rules = rows.map((r) => {
      const hostname = r.host.value.trim().toLowerCase();
      if (
        !hostname ||
        /[/:*\s@?#]/.test(hostname) ||
        new URL(`https://${hostname}`).hostname !== hostname
      )
        throw new Error(
          t(
            "Enter a hostname, not a URL or wildcard",
            "Nhập hostname, không dùng URL hoặc wildcard"
          )
        );
      const origins = r.destinations.value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => endpoint(v).origin);
      return {
        hostname,
        mode: r.mode.value,
        ...(r.provider.value ? { providerId: r.provider.value } : {}),
        ...(origins.length ? { allowedDestinations: origins } : {})
      };
    });
    for (const input of [historyTTL, cacheTTL])
      if (!input.checkValidity())
        throw new Error(
          t("Expiry must be 1–8760 hours", "Hạn lưu phải từ 1–8760 giờ")
        );
    await api.updateSettings({
      labFeatures: { ...settings.labFeatures, privacy: enabled.checked },
      privacyDefaultMode: defaultMode.value,
      privacyRules: rules,
      allowCloudFallback: fallback.checked,
      historyEnabled: history.checked,
      cacheEnabled: cache.checked,
      historyTTLHours: Number(historyTTL.value),
      cacheTTLHours: Number(cacheTTL.value)
    });
    api.status(
      t(
        "Privacy settings saved. Rules only apply while enabled.",
        "Đã lưu. Rule chỉ áp dụng khi được bật."
      )
    );
  });
  button(t("Clear history now", "Xóa lịch sử ngay"), async () => {
    await api.updateSettings({ translationHistory: [] });
    api.status(
      t(
        "History cleared, including pending old entries",
        "Đã xóa lịch sử, không phục hồi mục cũ đang chờ"
      )
    );
  });
  button(t("Clear cache now", "Xóa cache ngay"), async () => {
    await api.send("privacy-clear-cache");
    api.status(t("Cache cleared", "Đã xóa cache"));
  });
  container.append(panel);
  return () => {
    controller.abort();
    panel.remove();
  };
}
