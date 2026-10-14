# Super Share V1 — triển khai theo `supper share.docx`

## Kiến trúc

```
Web (web/)                      Extension service worker                    Trang Ads Manager
──────────                      ────────────────────────                    ─────────────────
Cấu hình + hiển thị   ──msg──►  batch-controller.js                        executor.js
(super-share.js)                 • batch tuần tự, delay giữa các TKQC        • DOM driver (nhãn VN/EN)
                      ◄─progress • PAUSED / resume / retry theo target       • đọc role, thêm, đổi, xóa
                                 • lưu batch vào chrome.storage              • verify bằng cách đọc lại
                                 • mở cửa sổ runner, điều hướng, inject            ▲
                                        │                                         │ gọi
                                        └──── shared/super-share-core.js ◄────────┘
                                              (toàn bộ BUSINESS LOGIC, không phụ thuộc trình duyệt)
```

- **`shared/super-share-core.js`**: 5 action, validate input, pre-validate keep-list, `NO_OTHER_ADMIN`, identity, verify, kết quả theo từng UID, mã lỗi. Web, Extension và test dùng chung một nguồn.
- **`extension/content-scripts/executor.js`**: chỉ thao tác UI. Mọi nhãn và pattern nằm trong `CONFIG` ở đầu file.
- **`extension/batch-controller.js`**: điều phối batch, không chứa logic nghiệp vụ.
- Hai engine thực thi cùng dùng core này: **DOM** (mặc định, `executor.js`) và **Graph** (thử nghiệm, xem mục "Graph engine" cuối tài liệu). Chọn bằng feature flag `super_share_engine` trong popup.

## Ánh xạ docx → code

| Docx | Nơi thực hiện |
|---|---|
| §2, §46 5 action, không Share BM | `ACTION_DEFS` trong core; dropdown ở `web/index.html` |
| §3, §47 input, tối đa 3 UID, keep 0–3 | `validateItem` (core), `checkUids` (web), validate lại ở controller |
| §4, §15 session / checkpoint → PAUSED | `startBatch`, `runBatchLoop`, `openPage` (controller); `sessionState` (executor) |
| §5 luồng chung (Ads Manager → settings → chọn TKQC bằng ID → mục vai trò) | `executeItemOnTab` (controller); `openAccount`, `ensureRolesBox` (executor) |
| §6, §40, §59 SHARE_USER: thêm / đã đúng / đổi role + verify | `shareOne` (core) |
| §7, §41 REMOVE theo UID, lỗi một UID không dừng các UID còn lại | `runRemoveByUid`, `forEachTarget` |
| §8, §9, §25, §33 xóa tất cả trừ…, pre-validate, đọc lại sau mỗi lần xóa | `runRemoveAllExcept` |
| §10, §27, §28 REMOVE_SELF, `NO_OTHER_ADMIN`, verify không phụ thuộc reload | `runRemoveSelf`, `probeSelfRemoval` |
| §11, §19 Jev không quyết định nghiệp vụ, không đoán | `locate()` (executor): Known DOM → semantic → Jev; fail rõ ràng |
| §12–§14, §36–§38, §49 tuần tự, delay 3–10s chỉ giữa TKQC, báo kết quả trước delay | `runBatchLoop` |
| §16, §34, §60 mã lỗi | `ERROR_CODES` (core) |
| §17, §30 result model đến cấp UID | `newItemResult`, `setTarget` |
| §26 `executor_uid` | `runItem` (core), `pickExecutorUid` (web) |
| §29, §52–§54 tiến trình thời gian thực | `commitBatch` → `execution_progress_update` |
| §42, §55 retry đúng target lỗi | `buildRetryItems` (core), `retryFailed` (controller) |
| §43, §51, §57 không Stop, một CTA, không popup giữa batch | web + controller |

## Điểm bổ sung / khác docx (cần bạn biết)

1. **Mã lỗi ngoài docx** (docx §35 yêu cầu lỗi tường minh thay vì đoán): `SELF_NOT_IDENTIFIED`, `TARGET_IS_SELF`, `INVALID_INPUT`.
2. **SHARE_USER hoặc REMOVE_BY_UID với UID = SELF**: docx không định nghĩa, nên báo `TARGET_IS_SELF`, không thao tác.
3. **Pause reason `EXTENSION_RESTARTED` / `CONTROLLER_ERROR`**: service worker MV3 có thể bị tắt giữa batch. Batch chuyển sang PAUSED để Tiếp tục, không chạy lại TKQC đã xong.
4. **Tải lại 1 lần** khi mục vai trò lỗi hoặc rỗng (`PAGE_LOAD_FAILED`, `ROLE_SECTION_NOT_FOUND`) và chưa có thao tác ghi nào.
5. **Điều hướng trực tiếp `?act=ID`**, chỉ dùng nếu verify được ID TKQC trên header; không thì fallback: mở bộ chọn tài khoản và Search theo ID, khớp chính xác (docx §5 Step 4).
6. **Ads Manager gốc mở 1 lần mỗi batch**, không mở lại cho từng TKQC.
7. **Delay cố định** theo giá trị người dùng chọn (docx §49 không nói ngẫu nhiên).
8. **Đã bỏ hàng đợi batch** của bản cũ (docx không có).
9. **Jev** qua OpenRouter: xem mục "Jev (OpenRouter)" bên dưới.
10. **`executor_uid`** lấy từ `viaUids` của TKQC, được ghi khi **Sync** ở Ads Check. TKQC đã sync trước thay đổi này cần **Sync lại**, nếu không các action phụ thuộc SELF (3 action Xóa và REMOVE_SELF) sẽ bị chặn với thông báo rõ ràng.
11. Runner chạy trong **một cửa sổ Chrome riêng** (không cướp focus) và được giữ mở khi PAUSED để bạn đăng nhập / xử lý checkpoint; tự đóng khi batch xong.
12. **AMIT chỉ nằm trong extension (quyết định của chủ dự án): không có server / Backend.** Các chỗ docx nhắc "Backend" và "CMS" (§28, §29, §30, §42, §53) được hiểu là Web nằm trong extension: kết quả gửi tới Web ngay sau mỗi TKQC, lưu đến cấp UID ở `chrome.storage.local` (batch) và `localStorage` (lịch sử, export CSV). Vì vậy đã gỡ `externally_connectable`, `onMessageExternal` và các host permission `localhost` / `*.amit.vn`: không trang web ngoài nào gọi được extension. Đánh đổi: dữ liệu nằm trong trình duyệt (xóa dữ liệu Chrome là mất lịch sử). Nếu sau này cần server, điểm cắm là `commitBatch()` trong `batch-controller.js`.
13. Lịch sử lưu kết quả **từng TKQC** (thành công lẫn thất bại) và chi tiết từng UID lỗi (docx §22); export CSV mỗi TKQC một dòng. Nguồn TKQC có đủ 3 loại của §45: tất cả / đã chọn ở Ads Check / theo danh sách ID.
14. **Sửa lỗi cũ**: tải theo danh sách ID mà không khớp ID nào trước đây nạp **tất cả** TKQC; giờ ở lại màn chọn nguồn.

## Jev (OpenRouter)

**Nơi đặt key duy nhất**: popup của extension → mục **Jev (OpenRouter)** → nhập key, chọn model, **Lưu**, bấm **Kiểm tra** để thử kết nối. Cấu hình lưu ở `chrome.storage.local[amit_jev_config]`, không nằm trong file hay repo. Mặc định Jev **tắt**.

Cách hoạt động (docx §11):

- Executor làm theo thứ tự *Known DOM → nhãn hiển thị → Jev*. Jev chỉ được hỏi khi hai bước đầu không xác định được control.
- Các điểm có Jev fallback: tìm mục vai trò (đúng goal của docx §5 Step 5), nút **Thêm người**, control chọn **role** (role vẫn do input quyết định, sau đó vẫn verify), nút **xác nhận**, control **Xóa** trên dòng, control **đổi role** trên dòng.
- Executor gửi `goal` + danh sách candidate (đã lọc theo scope của bước đó, ví dụ chỉ các control trong **đúng dòng** của UID đó) tới service worker; **service worker** mới gọi OpenRouter với key (endpoint xem bên dưới). Key không bao giờ ra khỏi service worker (không gửi cho content script hay web, popup chỉ nhận 4 ký tự cuối).
- Jev chỉ trả `{index, confidence}`. Code luôn validate: index phải nằm trong danh sách, confidence ≥ 0.8 (thấp hơn → `UI_TARGET_AMBIGUOUS`), **không bao giờ** nhận nút Hủy/Đóng/Quay lại (bị loại khỏi candidate trước khi gửi), tối đa 12 lần gọi mỗi TKQC, và mục vai trò do Jev chọn phải thật sự chứa dòng người dùng / nút Thêm người / nhãn role.
- **Hai endpoint theo loại model.** Jev (`jev-latest`, `~typesafe/jev-latest`, `typesafe/jev-1.13`...) là model *decisions*: **không** dùng được với `chat/completions` (OpenRouter báo
  "is a decisions model and cannot be used with the chat/completions endpoint"). Với các model này extension gọi `POST https://openrouter.ai/api/alpha/decisions` với MỘT câu hỏi kiểu `choice`:
  `state` = {step, goal}; `criteria` = mỗi candidate là một lựa chọn `c<index>` (mô tả = tag, role, nhãn đã che) cộng `none`; `instructions` giữ luật "chỉ định vị control, không chọn Hủy/Đóng".
  Phản hồi `answers.control` = {choice, confidence, probabilities}: `c<n>` -> index n, `none` -> không chọn, thiếu `confidence` thì dùng xác suất của lựa chọn, thiếu cả hai thì bỏ (không bịa).
  Model chat thường (vd `openai/gpt-4o-mini`) vẫn đi `chat/completions` như cũ. Endpoint chọn theo tên model; nếu OpenRouter báo "is a decisions model" thì tự chuyển sang decisions rồi nhớ trong phiên service worker.
  Lý do lỗi thật của OpenRouter (cắt 200 ký tự) được hiện ở thông báo thay vì chỉ "lỗi 400". Endpoint `/api/alpha/decisions` là bản **alpha** của OpenRouter nên hình dạng có thể đổi; schema lấy từ `openrouter.ai/openapi.json`.
- Jev **không** quyết định TKQC, UID, role, action, ai giữ / ai xóa; những thứ đó đã cố định trong input và trong goal.
- Mọi lần dùng Jev được ghi vào `result.jev` (bước, nhãn được chọn, confidence) để kiểm tra lại sau.
- Jev lỗi / tắt / hết thời gian (15 giây) → coi như không có Jev và trả lỗi UI tường minh; không bao giờ đoán.

Dữ liệu gửi tới OpenRouter: goal + nhãn các control (cắt 60 ký tự, dãy số ≥ 6 chữ số và email bị che thành `#` / `<email>`). Không gửi HTML, token, cookie, nội dung form. Lưu ý: nhãn vẫn có thể gồm **tên hiển thị** của người dùng trong dòng vai trò; nếu không muốn gửi, tắt Jev.

Model mặc định `~typesafe/jev-latest` chỉ là giá trị ban đầu, đổi trong popup (chưa kiểm chứng model nào trên Facebook thật; nút Kiểm tra chỉ thử một câu hỏi cố định). Cấu hình đã lưu từ trước (vd `openai/gpt-4o-mini`) được giữ nguyên.

## Log để user gửi lại cho dev

AMIT tự ghi log mọi thứ từ lúc cài, không cần bật. Khi có lỗi, user vào **Log & báo lỗi** (thanh bên của Web, hoặc popup) → **Xuất file log** → gửi file `AMIT-log-YYYYMMDD-HHMMSS.txt` cho bạn. Hướng dẫn cho user nằm ở [HUONG_DAN_TEST.md](HUONG_DAN_TEST.md) (tự được đưa vào gói khi chạy `npm run pack`).

**Đóng gói gửi user:** `npm run pack` → `dist/amit-extension-v<version>.zip` (chỉ gồm file extension cần, kiểm tra mọi file được `manifest.json` / `importScripts` / `executeScript` / thẻ `<script>` tham chiếu đều có mặt). Tăng `version` trong `manifest.json` mỗi lần gửi bản mới, để biết user đang chạy bản nào (version nằm ở header file log).

**Cấu trúc file:** dòng 1 là banner; dòng 2 là header JSON (version, trình duyệt, hệ điều hành, múi giờ, ghi chú của user, số dòng, số dòng cũ bị bỏ, cấu hình Jev không có key, các Via đã kết nối chỉ gồm UID, số TKQC, batch hiện tại); từ dòng 3 mỗi dòng là một sự kiện JSON `{ n, ts, ctx, lvl, ev, data }`.

- `ctx`: nơi phát ra: `sw` (service worker), `content` (trang Facebook / executor), `web`, `popup`, `logs`. `tab` là id tab của trang Facebook.
- `lvl`: `debug` / `info` / `warn` / `error`. Khi đọc, lọc `warn` và `error` trước.
- `ev` theo nhóm:
  - `sw.*`: vòng đời service worker, mọi message nhận / trả (`sw.msg.in` / `sw.msg.out` kèm thời gian và tóm tắt), phân giải session, discovery.
  - `batch.*`, `item.*`, `runner.*`: vòng đời batch, từng TKQC (`item.finish` có đầy đủ trạng thái, bước, mã lỗi, từng UID, chẩn đoán, nhật ký Jev), mở cửa sổ / điều hướng / inject, delay, pause / resume / retry.
  - `exec.*`: bên trong trang Facebook: ảnh chụp trang lúc bắt đầu (`exec.page.snapshot`: URL, heading, các control nhìn thấy), từng lời gọi driver (`exec.driver.*` với tham số, thời gian, kết quả hoặc lỗi + chẩn đoán), từng click, cách tìm control (`exec.locate*`: known / semantic / Jev), kết quả tìm người (`exec.add.search_result`), hộp thoại, xác minh role, tín hiệu sau `REMOVE_SELF`; `exec.core.*` là quyết định nghiệp vụ (thêm / đổi role / xóa / giữ / bỏ qua và lý do).
  - `jev.*`: đúng những gì gửi tới OpenRouter (goal + nhãn control đã che) và phản hồi (index, confidence, thời gian, lỗi).
  - `web.*`, `popup.*`: thao tác của người dùng (chọn nguồn, bấm Thực hiện kèm cấu hình, retry, resume), mọi thông báo hiện ra (`web.toast`), lỗi JavaScript.
  - `js.error`, `js.unhandled_rejection`: lỗi code ở mọi ngữ cảnh.

**Riêng tư / bảo mật:**
- Che theo **tên khóa** (token, secret, password, cookie, dtsg, lsd, api key, authorization, bearer, credential) và theo **mẫu chuỗi** (token `EAA…`, key `sk-or-…`, `Bearer …`, `access_token=…`, cookie `xs=`…), ở hai lớp: nơi ghi và kho lưu trữ. Giá trị đúng/sai (vd `hasToken`) được giữ lại.
- Tên người dùng trong danh sách vai trò bị che (`<name>`), link profile được ghi là `<profile link>`.
- Log **có** ID TKQC và UID Facebook (cần để tìm lỗi) và đúng nội dung thông báo lỗi.

**Giới hạn:** lưu tối đa ≈ 60.000 dòng (chunk 300 dòng, chunk cũ nhất bị bỏ trước); mỗi dòng ≤ 4 KB. `debug`/`info` được gom ghi mỗi ~0,8 giây, `warn`/`error` ghi ngay, nên nếu service worker bị tắt đột ngột có thể mất vài dòng debug cuối. Log nằm trong `chrome.storage.local`; user xóa dữ liệu extension thì mất log.

## CHƯA kiểm chứng với Facebook thật

Test tự động chỉ chạy trên trang giả do chúng tôi tự dựng. Các giả định sau **phải được bạn kiểm tra**:

- UID của từng dòng có nằm trong DOM không (link `profile.php?id=…` hoặc thuộc tính `data-*`). Nếu không: `UI_VARIANT_UNKNOWN`, và không có hành động ghi nào xảy ra (đúng docx §26).
- Nhãn nút "Thêm người" / "Xóa" / nhãn role, cấu trúc hộp thoại Thêm người, cách chọn role, cách xác nhận.
- Cách đổi role của người đã có quyền (menu trên dòng hoặc nút Chỉnh sửa).
- Tín hiệu xác nhận sau REMOVE_SELF.
- Tìm user bằng UID trong hộp thoại Thêm người (docx §21 `TEST_UID_SEARCH`).
- Việc đọc `c_user` có khớp `executor_uid` không.

### Thứ tự test an toàn (ít rủi ro trước)

0. Nạp lại extension → vào Ads Check bấm **Sync** (để có `viaUids`).
1. Chọn **một TKQC test có ít nhất 2 admin**. Mở trang cài đặt TKQC đó, chạy lệnh **DIAG** (bên dưới) xem executor thấy gì.
2. `REMOVE_BY_UID` với một UID **không có** trong danh sách → kỳ vọng SUCCESS (`NO_ACTION_REQUIRED`). Không ghi gì, nhưng kiểm tra được việc đọc danh sách và rút UID.
3. `REMOVE_ALL_EXCEPT_UIDS` với một keep UID sai → kỳ vọng FAILED `KEEP_UID_NOT_FOUND`, không ai bị xóa.
4. `SHARE_USER` cho một bạn bè với role **Nhà phân tích** (thấp nhất) → kiểm tra thêm và verify; rồi share lại cùng UID với role **Nhà quảng cáo** (kiểm tra đổi role); rồi `REMOVE_BY_UID` chính UID đó.
5. `REMOVE_ALL_EXCEPT_SELF` / `REMOVE_ALL_EXCEPT_UIDS` — **chỉ trên TKQC test**.
6. `REMOVE_SELF` — cuối cùng, trên TKQC test có admin khác.
7. Đăng xuất Facebook giữa batch → batch phải PAUSED; đăng nhập lại → **Tiếp tục** không chạy lại TKQC đã xong.

## Khi UI Meta khác dự kiến

- Mọi kết quả lỗi UI có `detail` (bên dưới "Chi tiết thất bại" hoặc trong `chrome.storage.local.amit_batch_current`): danh sách heading, control đang thấy, nhãn gần giống.
- Chỉnh ở `CONFIG` đầu `executor.js`:
  - `labels.*`: nhãn VN/EN của mục vai trò, nút Thêm người, Xóa, các role.
  - `knownSelectors`: nếu biết selector chắc chắn thì điền (ưu tiên hơn semantic).
  - `uidHrefPatterns`, `uidAttributes`: cách rút UID từ DOM.
  - `timeouts`.
- Chạy chẩn đoán trong Console của **service worker** (chrome://extensions → AMIT V1 → service worker), khi đã mở trang cài đặt TKQC:

```js
const [tab] = await chrome.tabs.query({ url: "*://adsmanager.facebook.com/*" });
await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["shared/super-share-core.js", "extension/content-scripts/executor.js"] });
await chrome.tabs.sendMessage(tab.id, { target: "AMIT_EXECUTOR", cmd: "DIAG" });
```

  Kết quả gồm: session, UID đọc được, ID TKQC trên header/URL, heading, danh sách control nhìn thấy.
- `spikes/spike2-uid-search.js` (`dumpRoles()`, `searchUid()`) vẫn dùng được để xem DOM mục vai trò và hộp thoại Thêm người.

## Chạy test

```bash
npm install        # chỉ cần cho test executor/web (jsdom)
npm test
```

- `core.test.js`: toàn bộ rule nghiệp vụ bằng driver giả.
- `controller.test.js`: batch, delay, PAUSED/resume, retry, khôi phục khi service worker bị tắt (API Chrome giả).
- `executor.test.js`, `web.test.js`: DOM giả (jsdom). **Chỉ chứng minh cơ chế code, không chứng minh khớp giao diện Meta thật.**

## Graph engine (`AMIT_Super_Share_Dinh_Huong_Kien_Truc.docx`)

Thay thao tác DOM bằng Facebook Graph chạy trong service worker. **Mặc định vẫn là DOM**; bật Graph ở popup → "Engine Super Share" (áp dụng cho batch tạo sau đó; engine được chốt trong `batch.engine`). Rollback = chọn lại DOM, không đổi dữ liệu lịch sử.

```
Web ──► batch-controller.js ──► AmitPermissionService (driver Graph) ──► AmitGraphClient ──► AmitTokenProvider
                │                      ▲ cùng interface driver với DOM          │ POST/GET v24.0        │ token_b + xác minh chủ token (/me)
                └── super-share-core.js (luật nghiệp vụ, verify, guard)         └── AmitFbErrors (phân loại lỗi)
```

| Module | Vai trò |
|---|---|
| `shared/facebook/permission-contracts.js` | role ID 1001/1002/1003, tasks, dựng request `users` / `assigned_users` / revoke |
| `shared/facebook/error-classifier.js` | lỗi Graph/mạng/redirect -> mã chuẩn, `retryable`, `pause`, `fallback_allowed` |
| `shared/facebook/token-provider.js` | token theo mục đích, cache + TTL + generation, kiểm tra chủ token |
| `shared/facebook/graph-client.js` | v24, token trong body, timeout 60s, retry token 1 lần, không tự retry mutation |
| `extension/services/permission-service.js` | driver Graph cho core, chọn contract, fallback có kiểm soát, bằng chứng REMOVE_SELF |
| `extension/services/permission-message-handler.js` | runtime singleton, feature flag, message `permission_execute` |

Khác biệt hành vi so với DOM (core chỉ đổi khi `driver.engine === "graph"`):

- **Danh tính**: mọi write (kể cả SHARE_USER) bắt buộc có `executor_uid` khớp chủ token; token được xác minh bằng `/me`, không tin regex.
- **Mutation thành công** khi `success === true`. Thiếu `success`, timeout, 5xx = *mơ hồ*: core đọc lại; khớp → `VERIFIED_AFTER_AMBIGUOUS_RESPONSE`, không khớp → FAILED với mã gốc (`REQUEST_TIMEOUT`...). Không tự gửi lại mutation.
- **Đọc lại không được** sau khi đã gửi → `VERIFY_UNAVAILABLE`, `verify_state: UNAVAILABLE` (tương đương UNVERIFIED trong docx; vẫn là `FAILED` + `retryable` ở model hiện tại).
- **Fallback** `users` ↔ `assigned_users` / `userpermissions` chỉ khi lỗi là *target không đủ điều kiện*; lỗi quyền, session, account, rate limit không bao giờ fallback.
- **Owner** của TKQC không bao giờ bị xóa (`OWNER_PROTECTED`).
- **REMOVE_SELF**: sau khi gỡ, đọc lại bị từ chối quyền = bằng chứng đã gỡ (`noAccess`); lỗi mạng/khác = không có tín hiệu → FAILED.
- **Pause**: `SESSION_EXPIRED`, `FACEBOOK_CHECKPOINT`, `FACEBOOK_REAUTH_REQUIRED`, `TOKEN_UNAVAILABLE`, `RATE_LIMITED` (rate limit nhận diện theo mã lỗi Graph 4/17/32/613/… không chỉ HTTP 429). Tiếp tục bằng nút "Tiếp tục" như cũ.
- **Retry** chỉ gửi lại target lỗi tạm thời hoặc chưa xác minh (`retryable`), bỏ qua lỗi quyền / target không hợp lệ.
- **Pacing**: 1–3 giây giữa các mutation cùng TKQC, 2–5 giây giữa TKQC (delay người dùng chọn > 5 giây thì tôn trọng); mutation tuần tự.
- Kết quả từng UID có thêm `request_id`, `method_used`, `verify_state`, `retryable`.
- **Rate limit tự backoff** (docx §10.2, §12): khi Graph báo giới hạn tốc độ, batch KHÔNG PAUSED ngay mà chờ rồi chạy lại chính TKQC đó
  (an toàn: core luôn đọc lại state trước khi ghi). Thời gian chờ = `Retry-After` của Facebook nếu có (làm mức tối thiểu), nếu không thì
  30s → 60s → 120s, cộng tối đa 20% jitter, trần 5 phút. Tối đa 3 lần mỗi TKQC; hết lần thì PAUSED như cũ để bấm "Tiếp tục".
  `Retry-After` > 5 phút thì không đứng chờ trong service worker mà PAUSED ngay. Trong lúc chờ, `batch.backoff` ({ attempt, max, wait_ms, until })
  được lưu và Web hiện đếm ngược. Cấu hình ở `SS_RATE_BACKOFF` (`batch-controller.js`). Chỉ Graph engine; checkpoint / login không bao giờ tự thử lại.
- **Xem trước và xác nhận trước khi xóa** (docx §7.3, §11.2) — chỉ Graph engine, áp dụng cho `REMOVE_ALL_EXCEPT_UIDS_AND_SELF`,
  `REMOVE_ALL_EXCEPT_SELF`, `REMOVE_SELF` (các action xóa phụ thuộc state; `REMOVE_BY_UID` tối đa 3 UID nên không cần):
  1. Bấm Thực hiện → Web gọi `super_share_preview` (chỉ GET, chia lô 10 TKQC, dừng ngay khi gặp checkpoint / rate limit) → modal liệt kê
     từng TKQC: ai bị xóa (tên, UID, vai trò), ai được giữ (Via này, chủ sở hữu, keep-list), TKQC bị luật chặn (`NO_OTHER_ADMIN`,
     `KEEP_UID_NOT_FOUND`, `OWNER_PROTECTED`...) và TKQC không đọc được (bị bỏ qua, không chạy).
  2. Mỗi TKQC có **snapshot** {created_at, executor_uid, owner_id, business_id, users (uid, role, via), keep_uids, remove_uids}; không chứa tên hay token.
  3. Bấm "Xác nhận và thực hiện" → batch chạy kèm snapshot. Extension **vẫn tính lại danh sách xóa từ state thật**; snapshot chỉ để CHẶN:
     quá 30 phút → `SNAPSHOT_EXPIRED`; có UID sắp bị xóa mà lúc xem trước không có (hoặc Via thực thi khác) → `SNAPSHOT_CHANGED`;
     cả hai đều không xóa ai và không Retry được (phải xem trước lại). Ít người hơn lúc xem trước thì vẫn an toàn.
  4. `startBatch` từ chối (`PREVIEW_REQUIRED`) mọi item xóa theo state không có snapshot khi engine là Graph, nên không đường nào bỏ qua được bước xem trước.
     Snapshot do Web gửi lên là dữ liệu không tin cậy (được làm sạch hình dạng) nhưng không thể làm xóa nhiều hơn state thật.
  5. Retry giữ nguyên snapshot đã xác nhận. DOM engine không đọc được state nếu không mở Ads Manager nên giữ luồng một CTA của docx gốc (§51).

### Số liệu nghiệm thu AC10 / AC11 và chỉ số vận hành (docx §17, §18.1)

Tự ghi từ mọi batch (cả DOM lẫn Graph), xem ở **trang Log & báo lỗi → "Số liệu nghiệm thu Graph engine"**. Code: `shared/metrics.js` (tính toán, thuần JS),
`extension/services/metrics-service.js` (ghi từ service worker). Dữ liệu ở `chrome.storage.local.amit_metrics`; **không chứa token, cookie, UID, tên hay nội dung lỗi**,
chỉ có ID TKQC (cần để ghép "cùng tập TKQC"). Giới hạn: 5000 target, 8000 request, 2000 sự kiện (bỏ bản ghi cũ nhất). Lỗi ghi số liệu không bao giờ làm hỏng batch.

| Tiêu chí | Cách tính | Kết luận |
|---|---|---|
| **AC10** | Tỷ lệ xác minh = (target SUCCESS có `verify_state = MATCH`) / (target có đọc lại: MATCH, MISSING, MISMATCH, UNAVAILABLE), chỉ Graph engine. Lỗi trước bước xác minh (input, quyền, danh tính...) đếm riêng, **không** làm giảm tỷ lệ; đọc lại không được (`UNAVAILABLE`) **có** làm giảm. | So với **ngưỡng do đội sản phẩm đặt** (ô "Ngưỡng AC10"; **không có mặc định**, chưa đặt = `NO_THRESHOLD`). |
| **AC11** | P95 thời gian mỗi target của Graph **<** P95 của DOM, chỉ trên các cặp (TKQC + action) **có ở cả hai engine**, chỉ target SUCCESS. Bằng nhau = FAIL. | `PASS` / `FAIL`. |

- Mỗi bên cần tối thiểu **30 mẫu** (đổi được ở ô "Số mẫu tối thiểu"); thiếu thì `INSUFFICIENT_DATA`, không đoán PASS.
- **Thời gian mỗi target** = thời gian TKQC chạy xong chia đều cho số target. Gồm: điều hướng + inject (DOM), settle 1 giây sau khi ghi và nghỉ 1–3 giây giữa các UID (Graph).
  **Không** gồm: chờ backoff rate limit, delay giữa các TKQC. Lần Retry không được tính (đếm riêng).
- Kết quả PAUSED chưa xong nên không ghi; khi chạy tiếp, kết quả cuối mới được ghi.
- Chỉ số vận hành đúng tên docx §18.1: `permission_requests_total` (engine, action, role, method, status), `permission_duration_ms` (P50/P95 theo method + endpoint, đã chuẩn hóa `/act_{id}/users`),
  `permission_verify_total`, `token_refresh_total` (slot, nguồn / `invalidated`), `batch_paused_total` (lý do), `retry_total` (mã lỗi, lần thử), thêm `rate_backoff_total`.
- File log xuất ra có thêm `metrics` (AC10, AC11, tóm tắt hai engine) trong header. Nút **Xuất số liệu (JSON)** cho đội sản phẩm: ID TKQC đã che ở giữa.

**Quy trình đo để AC11 có nghĩa** (cùng tập TKQC, cùng action, hai engine):
1. Chọn tập TKQC thử nghiệm (≥ 30), bấm **Xóa số liệu** để bắt đầu đợt đo mới.
2. Engine **DOM**: chạy `SHARE_USER` (vd role Nhà phân tích) trên cả tập, rồi `REMOVE_BY_UID` cùng UID để trả về trạng thái ban đầu.
3. Đổi popup sang engine **Graph**, chạy đúng hai bước trên với **đúng tập TKQC đó**.
4. Đặt ngưỡng AC10 (đội sản phẩm quyết định), bấm Làm mới, đọc AC10 / AC11. Nếu bị rate limit giữa chừng thì kết quả vẫn đúng vì thời gian backoff đã bị trừ.

Lưu ý khi đọc kết quả: đường ghi của Graph có **1 giây settle cố định** (`SETTLE_MS` trong `permission-service.js`) trước khi đọc lại, nên với TKQC chỉ có 1 UID đây là phần lớn thời gian của Graph.
Đó là mốc đầu tiên để tối ưu nếu AC11 không đạt.

### Chưa được kiểm chứng trên Facebook thật (đọc trước khi bật cho người dùng)

1. Contract **gỡ quyền** (`POST /act_{id}/users/{uid}` + `method=DELETE`, và `userpermissions`) là theo đặc tả AMIT, **không** có trong bằng chứng SMIT. Chạy `spikes/spike3-graph-contracts.js` trên TKQC thử nghiệm.
2. Mẫu thông báo nhận ra "target không đủ điều kiện" / "TKQC không tồn tại" trong `error-classifier.js` là suy đoán; mẫu lạ thì không fallback.
3. Mã lỗi khi tự gỡ chính mình rồi đọc lại (đang coi `INSUFFICIENT_PERMISSION` / `ACCOUNT_NOT_FOUND` là bằng chứng) cần xác nhận bằng log thật.
4. DNR rule đã thu hẹp về request do chính extension phát (`initiatorDomains`); cần kiểm tra Ads Check (discovery, inspect) vẫn chạy.
5. Backoff: Graph thường **không** gửi header `Retry-After` (chỉ có `x-app-usage` / `estimated_time_to_regain_access`), nên thực tế đa số là lùi cấp số nhân 30/60/120s; cần log thật để chỉnh `SS_RATE_BACKOFF`. Xem trước tốn thêm ~2-3 GET mỗi TKQC (chưa đo ảnh hưởng tới rate limit với 1000+ TKQC).
6. Concurrency mutation = 1 mỗi Via; chưa có telemetry tỷ lệ lỗi theo endpoint (log sự kiện `permission.*`, `token.*` đã có, metric tổng hợp chưa làm).
7. Ngưỡng AC10 (tỷ lệ xác minh thành công) vẫn do đội sản phẩm đặt: code **không** có giá trị mặc định nên AC10 hiện chỉ có thể là `NO_THRESHOLD` / `INSUFFICIENT_DATA` cho tới khi có con số. AC11 không cần ngưỡng nhưng cần chạy thật trên cả hai engine.
