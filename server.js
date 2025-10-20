const WebSocket = require("ws");
const wss = new WebSocket.Server({ port: 8080 });

let users = [];
let messages = [];
let connectedUsers = new Map(); // Map để lưu WebSocket connection của từng user

wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    switch (data.type) {
      case "connect":
        const user = data.user;
        user.isOnline = true;
        
        // Cập nhật hoặc thêm user mới
        const existingUserIndex = users.findIndex((u) => u.uid === user.uid);
        if (existingUserIndex !== -1) {
          users[existingUserIndex] = user;
        } else {
          users.push(user);
        }
        
        // Lưu connection của user
        connectedUsers.set(user.uid, ws);

        // Gửi dữ liệu khởi tạo cho user mới kết nối
        ws.send(
          JSON.stringify({
            type: "init",
            users: users.filter((u) => u.uid !== user.uid),
            messages: messages, // Gửi tất cả tin nhắn cũ
          })
        );

        // Thông báo user mới online cho tất cả client khác
        broadcast({ type: "new_user", user }, ws);
        broadcast({ type: "user_online", uid: user.uid }, ws);
        break;

      case "message":
        const msgData = data.message;
        // Thêm timestamp nếu chưa có
        if (!msgData.timestamp) {
          msgData.timestamp = new Date().toISOString();
        }
        messages.push(msgData);
        broadcast({ type: "message", message: msgData });
        break;

      case "message_update":
        const updatedMessage = data.message;
        const msgIndex = messages.findIndex(m => m.id === updatedMessage.id);
        if (msgIndex !== -1) {
          messages[msgIndex] = updatedMessage;
          broadcast({ type: "message_update", message: updatedMessage });
        }
        break;

      case "message_delete":
        const messageId = data.messageId;
        const deleteIndex = messages.findIndex(m => m.id === messageId);
        if (deleteIndex !== -1) {
          messages.splice(deleteIndex, 1);
          broadcast({ type: "message_delete", messageId: messageId });
        }
        break;

      case "sync_messages":
        const userId = data.userId;
        // Gửi tất cả tin nhắn cho user yêu cầu
        ws.send(
          JSON.stringify({
            type: "sync_messages",
            messages: messages,
          })
        );
        break;

      case "user_online":
        const onlineUid = data.uid;
        const onlineUser = users.find(u => u.uid === onlineUid);
        if (onlineUser) {
          onlineUser.isOnline = true;
          broadcast({ type: "user_online", uid: onlineUid });
        }
        break;

      case "user_offline":
        const offlineUid = data.uid;
        const offlineUser = users.find(u => u.uid === offlineUid);
        if (offlineUser) {
          offlineUser.isOnline = false;
          broadcast({ type: "user_offline", uid: offlineUid });
        }
        break;
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    
    // Tìm user tương ứng với connection bị đóng
    for (let [uid, connection] of connectedUsers.entries()) {
      if (connection === ws) {
        const user = users.find(u => u.uid === uid);
        if (user) {
          user.isOnline = false;
          broadcast({ type: "user_offline", uid: uid });
        }
        connectedUsers.delete(uid);
        break;
      }
    }
  });
});

function broadcast(data, excludeWs = null) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
      client.send(JSON.stringify(data));
    }
  });
}
