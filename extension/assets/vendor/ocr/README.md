# Assets OCR local

Toàn bộ runtime được đóng gói trong extension; không tải thư viện từ CDN.

- Tesseract.js **5.1.1**, `worker.min.js`, Apache-2.0 (`TESSERACT-LICENSE.md`). Thông báo license dependency trong `worker.min.js.LICENSE.txt`.
- tesseract.js-core **5.1.1**, Apache-2.0 (`CORE-LICENSE`). Có đủ bốn biến thể `.wasm.js` theo tài liệu local-installation chính thức, chứa sẵn binary WASM; không cần tải `.wasm` riêng. MVP chỉ dùng LSTM / SIMD-LSTM.
- Model tiếng Anh từ upstream chính thức `tesseract-ocr/tessdata_fast`, commit `87416418657359cb625c412a48b6e1d6d41c29bd`, Apache-2.0 (`TESSDATA-LICENSE`). Giải nén 4.113.088 byte. Không nhận model tùy ý từ người dùng, không tải ngôn ngữ lúc runtime.
- `offline-worker.js` là wrapper allowlist do BNTrans viết, không phải file upstream. Chỉ cho phép worker, LSTM core và model English đóng gói. Fetch/importScripts từ xa, XHR, WebSocket, EventSource đều bị chặn. Không fallback cloud.

Tái tạo bằng Node 24 và tar: `node scripts/vendor-ocr.mjs` (chỉ tải lúc phát triển, kiểm SHA-256 mọi nguồn). URL/hash được pin trong script; không sửa package.json, không cần npm install. Thư mục giải nén tạm được xóa sau khi chạy. Script giữ nguyên wrapper và README do BNTrans viết.

Tài liệu chính thức đã đọc:

- https://github.com/naptha/tesseract.js/blob/v5.1.1/docs/local-installation.md
- https://github.com/naptha/tesseract.js/blob/v5.1.1/docs/api.md
- https://github.com/naptha/tesseract.js/tree/v5.1.1/src/worker-script
- https://github.com/tesseract-ocr/tessdata_fast/tree/87416418657359cb625c412a48b6e1d6d41c29bd

## Tích hợp ở parent

Mount `extension/src/experimental/ocr.js` khi `settings.labFeatures.ocr === true` (module cũng tự kiểm tra). CSP cho extension-page: `script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'self'`. Không cần `unsafe-eval`, blob worker, nguồn từ xa, permission mới, thay đổi offscreen hay web-accessible resources: module và classic worker chạy trong trang extension. Giữ vendor assets trong gói extension. Fetch WASM nhúng `data:application/octet-stream;base64,` được cho phép local, giới hạn URL 6 MiB; đây không phải request từ xa hay imported script. Nếu parent thêm `connect-src`, cần kiểm tra đường fetch data WASM này khi test CSP.

Host adapter dùng protocol worker 5.1.1 được pin (`load`, `loadLanguage`, `initialize`, `recognize`) để có thể hủy Worker ngay khi đang khởi tạo; API async createWorker upstream không trả worker cho tới khi khởi tạo xong. Worker được tái sử dụng trong cùng lần mount, hủy khi cancel/lỗi/unmount; timeout 90 giây mỗi bước. `cacheMethod: none` bỏ IndexedDB có chủ đích vì model đã nằm trong gói extension. Module không lưu ảnh/text người dùng.

Chỉ upload PNG/JPEG, tối đa 8 MiB, 8000 px mỗi chiều và 12 MP; kiểm giới hạn trước decode. PNG tạo lại sau che/cắt có giới hạn 50 MiB. Upload ảnh chụp màn hình hoạt động; chưa capture trực tiếp do handler baseline không xác thực được tab Labs chọn. Tọa độ crop tính theo tỷ lệ kích thước canvas thực/hiển thị, không nhân DPR hai lần. Mask thay RGB và alpha bằng đen kín trước khi encode PNG. Muốn hoàn tác phải upload lại; crop xóa canvas cũ. OCR chỉ thấy preview đã xử lý. Dịch cần consent riêng, chỉ nhận text sửa được, `skipHistory: true`, siteUrl của tab được chọn, `privacyPolicy: local-only` bật mặc định; `cloudConsent` chỉ true khi người dùng bỏ local-only rồi xác nhận lại. Parent/background phải thi hành policy site/provider và giữ option này trong api.translate. Lỗi mạng/asset/CSP/ngôn ngữ không bao giờ fallback OCR cloud.

Parent sở hữu test UI/browser/MV3 CSP. Node test chạy worker/core/model thật không mạng, chỉ dùng pixel synthetic. Chỉ OCR tiếng Anh: không nhận dạng tiếng Việt/ngôn ngữ khác dù UI/ngôn ngữ dịch là tiếng Việt. Chưa nhận URL ảnh từ xa/cross-origin. Độ chính xác OCR không tuyệt đối: fixture chữ pixel sau che có nhầm O/D; người dùng phải kiểm tra/sửa text trước dịch.
