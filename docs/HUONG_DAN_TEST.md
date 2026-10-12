AMIT V1 — HƯỚNG DẪN CHẠY THỬ
=============================

1. CÀI EXTENSION
   - Giải nén file zip vào một thư mục cố định (đừng xóa thư mục này khi đang dùng).
   - Mở Chrome → gõ chrome://extensions → bật "Chế độ dành cho nhà phát triển" (góc trên bên phải).
   - Bấm "Tải tiện ích đã giải nén" → chọn thư mục vừa giải nén.
   - Ghim biểu tượng AMIT lên thanh công cụ để dễ mở.
   - Chrome phải đang đăng nhập Facebook (tài khoản Via cần test).

2. DÙNG THỬ
   - Bấm biểu tượng AMIT → "MỞ AMIT WORKSPACE".
   - Ads Check: bấm "Sync" để lấy danh sách TKQC.
   - Super Share: chọn nguồn TKQC → chọn hành động → nhập UID (nếu cần) → bấm "THỰC HIỆN".
   - Chỉ test trên TKQC thử nghiệm. Các hành động "Xóa" là thao tác THẬT trên Facebook.
   - Khi đang chạy, AMIT mở một cửa sổ Chrome riêng để thao tác. Đừng đóng cửa sổ đó.
     Nếu gặp màn hình đăng nhập / checkpoint, xử lý ngay trong cửa sổ đó rồi quay lại bấm "Tiếp tục".

3. NÊN TEST (theo thứ tự, an toàn trước)
   a) Sync TKQC.
   b) Xóa theo UID với một UID KHÔNG có trong TKQC (không thay đổi gì, chỉ kiểm tra đọc danh sách).
   c) "Xóa tất cả trừ UID giữ lại" với một UID giữ lại SAI (kỳ vọng báo lỗi, không ai bị xóa).
   d) Chia sẻ vai trò cho một người bạn bè: lần lượt với vai trò Nhà phân tích, Nhà quảng cáo, Quản trị viên.
   e) Xóa theo UID người vừa thêm.
   f) "Xóa tất cả trừ bạn" (chỉ trên TKQC thử nghiệm).
   g) "Xóa chính mình" (cuối cùng, TKQC phải còn quản trị viên khác).
   h) Đăng xuất Facebook giữa lúc đang chạy → batch phải tạm dừng; đăng nhập lại → bấm "Tiếp tục".
   i) Retry các TKQC thất bại.

4. KHI CÓ LỖI HOẶC TÍNH NĂNG CHẠY SAI  ← QUAN TRỌNG
   AMIT tự ghi lại mọi thao tác, kết quả và lỗi. Bạn KHÔNG cần bật gì.
   - Bấm "Log & báo lỗi" (ở thanh bên của Workspace, hoặc trong cửa sổ nhỏ khi bấm biểu tượng AMIT).
   - (Không bắt buộc) Gõ vài dòng mô tả: bạn đã làm gì, thấy gì, mong đợi gì.
   - Bấm "Xuất file log". File AMIT-log-….txt sẽ được tải về máy.
   - Gửi file đó cho người phát triển.
   Nên xuất log NGAY sau khi gặp lỗi (đừng đợi đến cuối buổi test). Một file log chứa toàn bộ lịch sử gần đây.

   File log có: ID tài khoản quảng cáo và UID Facebook (cần để tìm lỗi), thao tác bạn đã làm, kết quả và mã lỗi.
   File log KHÔNG có: mật khẩu, token, cookie, API key, tên người dùng Facebook.

5. (TÙY CHỌN) JEV
   Nếu người phát triển cung cấp OpenRouter API key: bấm biểu tượng AMIT → mục "Jev (OpenRouter)" →
   dán key → "Lưu" → "Kiểm tra". Jev giúp tìm nút khi giao diện Facebook thay đổi.
   Jev chỉ gửi tên các nút trên màn hình (đã che số dài), không gửi dữ liệu khác.
