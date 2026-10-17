# Hợp đồng module Labs

Labs là bản thử nghiệm opt-in. Các module là ES modules, không dùng inline handlers/eval hay code từ CDN. Giao diện có EN/VI qua `api.t(en, vi)`; chỉ render text qua textContent. Module xuất `mount(container, api)` (có thể async) và trả cleanup function nếu cần. Các hàm xử lý thuần nên export riêng để test bằng Node.

Parent quản lý manifest, trang labs.html, stylesheet, navigation và lab-api.js. Không sửa các file đó từ nhánh module.

API parent cung cấp:

- `api.t(en, vi)`: chuỗi ngôn ngữ giao diện.
- `api.settings()`: Promise settings hiện tại.
- `api.updateSettings(patch)`: merge settings qua background.
- `api.translate(text, options = {})`: Promise **chuỗi** bản dịch hoặc throw. options gồm sourceLanguage, targetLanguage, customPrompt, context, skipHistory (mặc định true), task, siteUrl, privacyPolicy. Khi không truyền ngôn ngữ dùng settings (source auto, target native).
- `api.send(type, payload = {})`: Promise runtime response, throw khi `ok === false`.
- `api.tabs()`: danh sách tab HTTP(S)/file được cấp quyền. `api.activeTab()`: tab người dùng chọn trên Labs; `api.sendToTab(type, payload={})`: gửi message vào **top frame** của tab đó; không tự chọn hoặc đọc mọi tab.
- `api.get(key, fallback = null)`, `api.set(key, value)`: storage.local dùng key prefix `bntransLabs:`. Module tự namespace và không lưu API keys.
- `api.status(message, kind='info')`: hiển thị trạng thái/aria-live của shell.
- `api.download(filename, textOrBlob, mime='text/plain;charset=utf-8')`: Blob download rồi revoke URL.
- `api.button(label, callback)`: button type=button, chạy callback async với disabled/error handling.
- `api.field(label, element)`: wrapper label cho input/select/textarea.

Module panel phải dùng class `lab-panel`, `lab-toolbar`, `lab-field`, `lab-result`, `lab-list`, `lab-card` khi phù hợp. Mỗi heading giải thích giới hạn thực tế. Không dùng emoji/icon mặc định; button chữ hoặc SVG nhất quán nếu thực sự cần.

Tín hiệu content-script (parent gắn classic script `src/experimental/content-labs.js` sau main nếu cần):

- `bntrans-labs-selection` CustomEvent detail `{text, context, url}` trên document: lưu selection vào sổ từ. Module content không được gửi password/sensitive inputs.
- Messages page engine: `labs-page-command` payload `{command:'translate'|'restore'|'pause'|'resume'|'mode', mode:'original'|'bilingual'|'translation'}`.
- Messages media engine: `labs-media-command` payload `{command:'start'|'stop'|'seek'|'replay'|'snapshot', adapter:'youtube'|'netflix'|'meet', time?, options?}`. Snapshot trả `{ok:true,cues:[{id,start,end,text,translation}],videoId?,supported?}`. Chỉ đọc caption DOM hợp lệ, không vượt DRM/đăng nhập.
- Settings opt-in từ `settings.labFeatures` (object boolean keys `learning`, `writing`, `media`, `documents`, `ocr`, `privacy`, `page`). Tự động observer/highlight chỉ hoạt động khi flag tương ứng true; default false. Các hành động thủ công trong module vẫn yêu cầu flag được bật ở shell.

Privacy contract với background (worker agent sở hữu):

- `settings.privacyRules`: `[{hostname, mode:'local-only'|'cloud'|'ask', providerId?}]`, exact hostname hoặc subdomain boundary; không thay semantics autoTranslateDomains legacy.
- `settings.privacyDefaultMode`: `cloud` nếu chưa đặt, nhưng local provider lỗi **không** tự fallback cloud trừ `settings.allowCloudFallback === true` và policy cho phép.
- Payload `siteUrl` ưu tiên tab thực tế từ sender khi có sender.tab; `privacyPolicy` có thể siết chặt thành local-only nhưng không được nới policy site. `cloudConsent:true` là xác nhận một hành động từ UI extension trong ask mode.
- Incognito/retention/budget settings nếu thêm phải có defaults an toàn và test. Cache identity gồm config hiệu lực/prompt/context; không log keys/nội dung nhạy cảm.

Không thêm menu trống/chức năng giả: nếu browser/provider không hỗ trợ, hiện capability error rõ ràng, không giả kết quả thành công. Test tự động gồm edge cases, không chỉ marker/string presence. Commit conventional, không PR/merge main từ agent module.
