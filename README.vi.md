# Browser Agent

[English](README.md) | **Tiếng Việt**

Extension Chrome không chính thức. Tác tử chạy trong side panel, đọc và thao tác trên trang web, bằng API key Claude của bạn hoặc qua Claude Code trong terminal.

## Cài đặt

1. Giải nén thư mục này.
2. Mở `chrome://extensions` và bật **Developer mode**.
3. Chọn **Load unpacked**, rồi chọn thư mục đã giải nén. ID của extension luôn là `eboigejnblbcifgbpgaadonkpgbdbnkc`; nếu trước đó bạn đã nạp bản cũ (ID khác), hãy gỡ bản cũ đi và nhập lại cài đặt.
4. Bấm biểu tượng extension để mở side panel.
5. Chọn cách dùng:
   - **Chat trong panel**: giao việc ngay trong panel. Nhập API key, bấm **Kiểm tra** để xác nhận key và chọn model, rồi **Lưu**.
   - **Điều khiển từ Claude Code**: Claude Code trong terminal thao tác trình duyệt, không cần API key (xem mục bên dưới).

Hai cách dùng loại trừ nhau. Đổi bằng nút chế độ ở góc trên bên trái; khi đổi, mọi việc của chế độ cũ đều dừng. Chấm xanh cạnh tên chế độ nghĩa là đã sẵn sàng: có API key, hoặc có ít nhất một phiên Claude Code đã kết nối.

## Ngôn ngữ hiển thị

Panel có tiếng Anh và tiếng Việt. Mặc định theo ngôn ngữ của trình duyệt (tiếng Việt nếu trình duyệt ưu tiên tiếng Việt, còn lại là tiếng Anh).

- Đổi ngay ở màn hình chọn cách dùng (nút **English** / **Tiếng Việt**), hoặc ở **Cài đặt → Ngôn ngữ** (chọn **Tự động** để theo trình duyệt).
- Câu hỏi xác nhận mà Claude Code hiện trong terminal cũng theo ngôn ngữ này.
- Các dòng đã có trong nhật ký giữ nguyên ngôn ngữ lúc chúng được ghi.
- Tên và mô tả extension trong `chrome://extensions` theo ngôn ngữ giao diện của Chrome.

## Dùng qua gateway của công ty

Ở chế độ Chat, mở **Cài đặt** và tick **Dùng gateway công ty**:

- **API base URL**: địa chỉ gateway, ví dụ `https://llm-gateway.congty.vn/anthropic`. Có hay không có `/v1` ở cuối đều được. Để trống thì dùng `https://api.anthropic.com`.
- **Kiểu xác thực**: `x-api-key` cho Anthropic, hoặc `Authorization: Bearer` nếu gateway yêu cầu.
- **Model**: bấm **Kiểm tra** để lấy danh sách model mà key hoặc gateway cho phép, qua `GET /v1/models` (định dạng Anthropic có phân trang, hoặc dạng `{ data: [{ id }] }`). Danh sách cũng tự tải lại sau khi bạn lưu base URL, kiểu xác thực hoặc key mới, và được lưu lại cho lần mở sau. Chọn **Nhập tên khác…** để gõ tên model không có trong danh sách. Nếu gateway không có `/v1/models`, bạn nhập tên model thủ công.
- Gateway phải hỗ trợ Messages API (`/v1/messages`) và chuyển tiếp nguyên tool `browser_toolset_20260801` cùng các trường `toolset_name` và `browser_state`.

Chrome sẽ hiện thanh thông báo "đang gỡ lỗi trình duyệt" khi tác tử điều khiển tab. Nếu bạn tắt thanh này, tác vụ sẽ dừng.

## Điều khiển từ Claude Code (terminal)

Claude Code trong terminal có thể điều khiển Chrome qua extension này, giống Claude in Chrome. Ở chế độ này Claude Code là bên gọi model, nên extension không cần API key; gateway công ty (nếu có) cấu hình phía Claude Code.

```
Claude Code (terminal 1) ──stdio──▶ MCP server :18765 ──┐
Claude Code (terminal 2) ──stdio──▶ MCP server :18766 ──┼─WebSocket 127.0.0.1──▶ side panel ──▶ tab Chrome
                                                   …     ┘
```

1. Cài plugin (cần Node.js 18 trở lên):

   ```
   /plugin marketplace add nqh98/browser-agent-extension
   /plugin install browser-agent@browser-agent-extension
   ```

   Với bản sao trên máy, thay `nqh98/browser-agent-extension` bằng đường dẫn tới thư mục. Hoặc không dùng plugin: `claude mcp add browser-agent -- node /đường/dẫn/tới/browser-agent-extension/claude-code/server/index.js`.
2. Khởi động lại Claude Code.
3. Trong side panel, chọn **Điều khiển từ Claude Code**. Panel tự kết nối; mỗi phiên hiện thành một hàng có màu riêng, trạng thái, số tab và nút **Dừng**. Header hiện **Claude Code ×2** khi có hai phiên.
4. Giữ side panel mở, rồi bảo Claude Code làm việc trên trình duyệt, ví dụ "mở example.com và tóm tắt trang". Claude Code có thể gọi tool `bridge_status` để kiểm tra kết nối.

Cách hoạt động:

- Các tool `mcp__browser-agent__*` (`navigate`, `read_page`, `find`, `left_click`, `form_input`, `screenshot`…) ứng với các member tool của extension và có cùng tham số.
- Quyền theo tên miền, mức tự động, phát hiện thao tác nhạy cảm và tool tùy chọn vẫn áp dụng như khi chạy trong panel. Claude Code chờ tới khi bạn trả lời (tối đa 10 phút).
- Xác nhận ngay trong terminal: Claude Code hiện hộp "MCP server "browser-agent" requests your input". **Accept** là cho phép, **Decline** hoặc Esc là từ chối. Ô **Phạm vi** (đã chọn sẵn) cho phép mở rộng thành "đến hết tác vụ", hoặc "luôn cho phép" với trang web; thao tác nhạy cảm chỉ có Accept/Decline. Cùng lúc đó panel cũng hiện thẻ xác nhận; trả lời ở đâu trước thì bên kia tự đóng. Muốn chỉ hỏi trong panel: **Cài đặt → Kết nối Claude Code → Hỏi xác nhận ở → Chỉ panel**. Khi Claude Code chạy không tương tác (`claude -p`), câu hỏi trong terminal được coi là từ chối, nên hãy trả lời trong panel hoặc dùng mức tự động.
- Mỗi thao tác được ghi trong panel kèm tên phiên. Nút **Dừng** trên hàng của phiên cắt thao tác đang chạy của phiên đó, và lần gọi kế tiếp báo cho Claude Code rằng bạn đã dừng.
- Muốn Claude Code tải tệp lên trang, bật **Tải lên tệp** trong Tool tùy chọn rồi bấm **📎 Đính kèm tệp**. Tool `bridge_status` liệt kê các tệp này theo mã `doc-N`.
- Sau 3 phút Claude Code không gọi tool, extension thả quyền điều khiển tab và thanh "đang gỡ lỗi" biến mất.
- An toàn: server chỉ nghe trên `127.0.0.1` và chỉ nhận kết nối có origin đúng ID của extension này (`chrome-extension://eboigejnblbcifgbpgaadonkpgbdbnkc`, cố định nhờ `key` trong `manifest.json`). Trình duyệt tự đặt origin nên trang web và extension khác không giả được. Trên máy có nhiều người dùng hệ điều hành, đặt thêm biến `BROWSER_AGENT_TOKEN` cho Claude Code và nhập cùng giá trị vào ô Token trong panel. Nếu đóng gói lại extension với key khác, đặt `BROWSER_AGENT_EXTENSION_ID` cho server.

Nhiều terminal cùng lúc:

- Mỗi phiên Claude Code tự lấy cổng trống đầu tiên trong `18765`–`18774`, panel kết nối tới cả 10 cổng. Tối đa 10 phiên song song. Đổi khoảng cổng bằng biến `BROWSER_AGENT_PORT` (cổng đầu) và ô **Cổng đầu** trong panel.
- Mỗi phiên được gắn nhãn theo tên thư mục nơi chạy Claude Code (đổi bằng `BROWSER_AGENT_LABEL`). Nhãn có màu riêng và hiện trên hàng của phiên, trong nhật ký thao tác, trên thẻ xác nhận và trong câu hỏi ở terminal.
- Mỗi phiên có tab, quyền tên miền và trạng thái riêng. Tab đang mở thuộc về phiên đầu tiên dùng nó; phiên khác gọi `new_tab` sẽ được mở trong cửa sổ riêng, để các phiên không phải tranh nhau tab đang hiển thị khi chụp màn hình.
- Đóng một terminal chỉ ngắt phiên của terminal đó. Cổng và token nằm trong **Cài đặt → Nâng cao**, chỉ cần khi đổi `BROWSER_AGENT_PORT` hoặc đặt `BROWSER_AGENT_TOKEN`.

### Khi cập nhật

Claude Code giữ nguyên MCP server đã khởi động, nên sau khi plugin được cập nhật, các phiên đang mở vẫn chạy code cũ. Panel và server tự phát hiện việc này và nói rõ cần làm gì:

- Panel ghi **plugin cũ** trên hàng của phiên, hoặc báo "Cổng …: một phiên Claude Code đang chạy bản plugin cũ". Khi đó, trong terminal của phiên ấy, gõ `/mcp` → chọn **browser-agent** → **Reconnect**. Panel tự nhận lại phiên sau vài giây, không cần thao tác gì thêm.
- Claude Code báo extension cũ hơn plugin: vào `chrome://extensions`, bấm tải lại **Browser Agent**, rồi mở lại side panel.
- Không cần tự đặt cổng: mỗi phiên tự lấy cổng trống.

## Quyền và an toàn

- Mỗi tên miền phải được bạn cho phép trước khi tác tử đọc hoặc thao tác trên đó.
- Mức mặc định hỏi trước mỗi thao tác thay đổi trang.
- Mức "Chỉ hỏi thao tác nhạy cảm" vẫn hỏi với các thao tác có vẻ nhạy cảm như mua, xóa, gửi, hoặc nhập vào ô mật khẩu. Việc phát hiện này dựa trên từ khóa (tiếng Anh và tiếng Việt) nên có thể bỏ sót.
- Nội dung trang và ảnh chụp màn hình được gửi tới Claude. Nên dùng một hồ sơ Chrome riêng, không đăng nhập các tài khoản quan trọng.
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
- **Chạy JavaScript** (`javascript_exec`): chạy trong trang với toàn quyền của trang. Mã được hiện trong nhật ký. Ở mức hỏi mọi thao tác, mỗi lần chạy đều hỏi. Ở mức chỉ hỏi thao tác nhạy cảm, mã có dấu hiệu gửi dữ liệu, đọc cookie hoặc storage, hoặc thay đổi trang vẫn bị hỏi; việc phát hiện dựa trên từ khóa nên có thể bỏ sót.

Tệp tải xuống trong lúc tác vụ chạy được báo cho Claude (`download_started`, `download_completed`, `download_failed`), không kèm đường dẫn và không kèm query string của URL.

## Giới hạn hiện tại

- `find` so khớp theo từ khóa, không hiểu ngữ nghĩa.
- Không hoạt động trên trang `chrome://` và Chrome Web Store.
- Cuộc trò chuyện mất khi đóng side panel.

## Cấu trúc

- `sidepanel.*`: giao diện và cài đặt.
- `i18n.js`: chuỗi hiển thị tiếng Anh và tiếng Việt; `_locales/` cho tên và mô tả extension.
- `agent.js`: vòng lặp Messages API.
- `browser.js`: thực thi các member tool của `browser_toolset_20260801`, ghép cây trang qua các frame và đổi tham chiếu cục bộ thành `ref_N` duy nhất trong tab.
- `page-agent.js`: đọc trang và quản lý tham chiếu cục bộ trong isolated world của từng frame.
- `capture.js`: ghi nhận console và request mạng, che thông tin nhạy cảm.
- `keys.js`: chuyển đổi phím sang Chrome DevTools Protocol.
- `bridge-client.js`: kết nối side panel với MCP server của Claude Code.
- `claude-code/`: plugin Claude Code, gồm MCP server không phụ thuộc thư viện ngoài (`server/`) và skill hướng dẫn dùng tool.

## Kiểm thử

`tests/e2e/run.js` nạp extension vào Chromium qua Playwright, giả lập Claude API bằng các phản hồi kịch bản sẵn, và chạy mọi member tool trên một trang thử nghiệm cục bộ. Mỗi request gửi đi được kiểm tra theo quy tắc định dạng của `browser_toolset_20260801` (`toolset_name`, `browser_state`, thông báo dừng batch, kích thước ảnh). `tests/e2e/bridge.js` chạy MCP server thật và gọi nó như Claude Code, gồm cả câu hỏi xác nhận trong terminal, nhiều phiên cùng lúc và cả hai ngôn ngữ. Không cần API key.

```sh
npm i -D playwright   # nếu chưa có
node tests/e2e/run.js
node tests/e2e/bridge.js   # Claude Code → MCP server → extension
```
