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
- Executor gửi `goal` + danh sách candidate (đã lọc theo scope của bước đó, ví dụ chỉ các control trong **đúng dòng** của UID đó) tới service worker; **service worker** mới gọi `https://openrouter.ai/api/v1/chat/completions` với key. Key không bao giờ ra khỏi service worker (không gửi cho content script hay web, popup chỉ nhận 4 ký tự cuối).
- Jev chỉ trả `{index, confidence}`. Code luôn validate: index phải nằm trong danh sách, confidence ≥ 0.8 (thấp hơn → `UI_TARGET_AMBIGUOUS`), **không bao giờ** nhận nút Hủy/Đóng/Quay lại (bị loại khỏi candidate trước khi gửi), tối đa 12 lần gọi mỗi TKQC, và mục vai trò do Jev chọn phải thật sự chứa dòng người dùng / nút Thêm người / nhãn role.
- Jev **không** quyết định TKQC, UID, role, action, ai giữ / ai xóa; những thứ đó đã cố định trong input và trong goal.
- Mọi lần dùng Jev được ghi vào `result.jev` (bước, nhãn được chọn, confidence) để kiểm tra lại sau.
- Jev lỗi / tắt / hết thời gian (15 giây) → coi như không có Jev và trả lỗi UI tường minh; không bao giờ đoán.

Dữ liệu gửi tới OpenRouter: goal + nhãn các control (cắt 60 ký tự, dãy số ≥ 6 chữ số và email bị che thành `#` / `<email>`). Không gửi HTML, token, cookie, nội dung form. Lưu ý: nhãn vẫn có thể gồm **tên hiển thị** của người dùng trong dòng vai trò; nếu không muốn gửi, tắt Jev.

Model mặc định `openai/gpt-4o-mini` chỉ là giá trị ban đầu, đổi trong popup sang model bạn muốn dùng (chưa kiểm chứng model nào trên Facebook thật; nút Kiểm tra chỉ thử một câu hỏi cố định).

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

### Chưa được kiểm chứng trên Facebook thật (đọc trước khi bật cho người dùng)

1. Contract **gỡ quyền** (`POST /act_{id}/users/{uid}` + `method=DELETE`, và `userpermissions`) là theo đặc tả AMIT, **không** có trong bằng chứng SMIT. Chạy `spikes/spike3-graph-contracts.js` trên TKQC thử nghiệm.
2. Mẫu thông báo nhận ra "target không đủ điều kiện" / "TKQC không tồn tại" trong `error-classifier.js` là suy đoán; mẫu lạ thì không fallback.
3. Mã lỗi khi tự gỡ chính mình rồi đọc lại (đang coi `INSUFFICIENT_PERMISSION` / `ACCOUNT_NOT_FOUND` là bằng chứng) cần xác nhận bằng log thật.
4. DNR rule đã thu hẹp về request do chính extension phát (`initiatorDomains`); cần kiểm tra Ads Check (discovery, inspect) vẫn chạy.
5. Concurrency mutation = 1 mỗi Via; chưa có telemetry tỷ lệ lỗi theo endpoint (log sự kiện `permission.*`, `token.*` đã có, metric tổng hợp chưa làm).
6. Ngưỡng nghiệm thu AC10 / AC11 (tỷ lệ verify thành công, P95) cần được đội sản phẩm đặt số cụ thể.
