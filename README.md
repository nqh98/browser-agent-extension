# Browser Agent (API key)

Extension Chrome không chính thức. Tác tử chạy trong side panel, đọc và thao tác trên trang web bằng API key Claude của bạn.

## Cài đặt

1. Giải nén thư mục này.
2. Mở `chrome://extensions` và bật **Developer mode**.
3. Chọn **Load unpacked**, rồi chọn thư mục đã giải nén.
4. Bấm biểu tượng extension để mở side panel.
5. Nhập API key, chọn model và bấm **Lưu**.

Chrome sẽ hiện thanh thông báo "đang gỡ lỗi trình duyệt" khi tác tử điều khiển tab. Nếu bạn tắt thanh này, tác vụ sẽ dừng.

## Quyền và an toàn

- Mỗi tên miền phải được bạn cho phép trước khi tác tử đọc hoặc thao tác trên đó.
- Chế độ mặc định hỏi trước mỗi thao tác thay đổi trang.
- Chế độ tự động vẫn hỏi với các thao tác có vẻ nhạy cảm như mua, xóa, gửi, hoặc nhập vào ô mật khẩu. Việc phát hiện này dựa trên từ khóa nên có thể bỏ sót.
- Nội dung trang và ảnh chụp màn hình được gửi tới Claude API. Nên dùng một hồ sơ Chrome riêng, không đăng nhập các tài khoản quan trọng.
- API key được lưu không mã hóa trong `chrome.storage.local`. Không phát hành extension này kèm key của team.

## Giới hạn hiện tại

- Chưa đọc được nội dung trong iframe qua cấu trúc trang; tác tử phải dùng ảnh chụp màn hình và click theo tọa độ.
- `find` so khớp theo từ khóa, không hiểu ngữ nghĩa.
- Chưa bật `javascript_exec`, `file_upload`, `read_console`, `read_network`, và chưa báo cáo tệp tải xuống.
- Không hoạt động trên trang `chrome://` và Chrome Web Store.
- Cuộc trò chuyện mất khi đóng side panel.

## Cấu trúc

- `sidepanel.*`: giao diện và cài đặt.
- `agent.js`: vòng lặp Messages API.
- `browser.js`: thực thi các member tool của `browser_toolset_20260801`.
- `page-agent.js`: đọc trang và quản lý tham chiếu `ref_N` trong isolated world.
- `keys.js`: chuyển đổi phím sang Chrome DevTools Protocol.
