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

## Khung nhúng (iframe)

- `read_page`, `find`, `get_page_text` và các thao tác theo `ref` hoạt động cả trong iframe, kể cả iframe lồng nhau và iframe từ trang khác.
- Iframe cùng tên miền với trang, hoặc dạng `about:blank`/`srcdoc`, được coi là một phần của trang.
- Iframe từ trang khác cần bạn cho phép riêng, giống như khi tác tử mở một trang mới. Nếu bạn từ chối, nội dung khung không được gửi tới Claude và tên miền đó không bị hỏi lại cho đến khi tạo chat mới. `find` và `get_page_text` không hỏi mà bỏ qua các khung chưa được phép.
- Click theo tọa độ vào một khung chưa được phép luôn cần xác nhận.

## Tool tùy chọn

Bật trong **Cài đặt → Tool tùy chọn**. Mặc định tắt cả bốn tool.

- **Đọc console** (`read_console`) và **Đọc request mạng** (`read_network`): chỉ ghi nhận từ lúc tác tử bắt đầu thao tác trên tab trong một tác vụ. Mỗi lần đọc trả về các mục mới kể từ lần đọc trước. Token, khóa API và tham số nhạy cảm trong URL được che, và mỗi mục bị cắt ở 500 ký tự. Không ghi nhận console của iframe chạy ở tiến trình riêng.
- **Tải lên tệp** (`file_upload`): bấm 📎 để đính kèm tệp (tổng tối đa 25 MB). Tác tử chỉ tải lên được các tệp này, theo mã `doc-N`; đường dẫn trên máy luôn bị từ chối. Mỗi lần tải lên đều hỏi bạn.
- **Chạy JavaScript** (`javascript_exec`): chạy trong trang với toàn quyền của trang. Mã được hiện trong nhật ký. Ở chế độ hỏi trước, mỗi lần chạy đều hỏi. Ở chế độ tự động, mã có dấu hiệu gửi dữ liệu, đọc cookie hoặc storage, hoặc thay đổi trang vẫn bị hỏi; việc phát hiện dựa trên từ khóa nên có thể bỏ sót.

Tệp tải xuống trong lúc tác vụ chạy được báo cho Claude (`download_started`, `download_completed`, `download_failed`), không kèm đường dẫn và không kèm query string của URL.

## Giới hạn hiện tại

- `find` so khớp theo từ khóa, không hiểu ngữ nghĩa.
- Không hoạt động trên trang `chrome://` và Chrome Web Store.
- Cuộc trò chuyện mất khi đóng side panel.

## Cấu trúc

- `sidepanel.*`: giao diện và cài đặt.
- `agent.js`: vòng lặp Messages API.
- `browser.js`: thực thi các member tool của `browser_toolset_20260801`, ghép cây trang qua các frame và đổi tham chiếu cục bộ thành `ref_N` duy nhất trong tab.
- `page-agent.js`: đọc trang và quản lý tham chiếu cục bộ trong isolated world của từng frame.
- `capture.js`: ghi nhận console và request mạng, che thông tin nhạy cảm.
- `keys.js`: chuyển đổi phím sang Chrome DevTools Protocol.

## Kiểm thử

`tests/e2e/run.js` nạp extension vào Chromium qua Playwright, giả lập Claude API bằng các phản hồi kịch bản sẵn, và chạy mọi member tool trên một trang thử nghiệm cục bộ. Mỗi request gửi đi được kiểm tra theo quy tắc định dạng của `browser_toolset_20260801` (`toolset_name`, `browser_state`, thông báo dừng batch, kích thước ảnh). Không cần API key.

```sh
npm i -D playwright   # nếu chưa có
node tests/e2e/run.js
```
