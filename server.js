const WebSocket = require("ws");
const Redis = require("ioredis");

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const pub = new Redis(redisUrl);
const sub = new Redis(redisUrl);

const wss = new WebSocket.Server({ port: 8080 }, () => {
  console.log(" WebSocket Server is running on port 8080");
});

let users = []; 
let messages = []; 
let connectedUsers = new Map(); 

// Hàm broadcast gửi cho tất cả client (trừ một ws nếu cần)
function broadcast(data, excludeWs = null) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
      client.send(JSON.stringify(data));
    }
  });
}

// Khi client kết nối
wss.on("connection", (ws) => {
  console.log(" Client connected");

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    switch (data.type) {
      // 🔹 Khi user mới connect
      case "connect": {
        const user = data.user;
        user.isOnline = true;

        const existingUserIndex = users.findIndex((u) => u.uid === user.uid);
        if (existingUserIndex !== -1) {
          users[existingUserIndex] = user;
        } else {
          users.push(user);
        }

        connectedUsers.set(user.uid, ws);

        // Gửi dữ liệu khởi tạo
        ws.send(
          JSON.stringify({
            type: "init",
            users,
            messages,
          })
        );

        //  Kiểm tra tin nhắn offline trong Redis
        (async () => {
          const offlineMsgs = await pub.lrange(`offline:${user.uid}`, 0, -1);
          if (offlineMsgs.length > 0) {
            console.log(`📨 Gửi ${offlineMsgs.length} tin nhắn offline cho ${user.name}`);
            for (const msg of offlineMsgs) {
              ws.send(JSON.stringify({ type: "message", message: JSON.parse(msg) }));
            }
            await pub.del(`offline:${user.uid}`);
          }
        })();

        broadcast({ type: "new_user", user });
        broadcast({ type: "user_online", uid: user.uid });
        break;
      }

      //  Khi user gửi tin nhắn
      case "message": {
        const msgData = data.message;
        if (!msgData.timestamp) msgData.timestamp = new Date().toISOString();
        messages.push(msgData);

        // Publish qua Redis để phân tán
        pub.publish("chat_channel", JSON.stringify(msgData));
        break;
      }

      //  Cập nhật tin nhắn
      case "message_update": {
        const updated = data.message;
        const idx = messages.findIndex((m) => m.id === updated.id);
        if (idx !== -1) {
          messages[idx] = updated;
          broadcast({ type: "message_update", message: updated });
        }
        break;
      }

      //  Xóa tin nhắn
      case "message_delete": {
        const messageId = data.messageId;
        const index = messages.findIndex((m) => m.id === messageId);
        if (index !== -1) {
          messages.splice(index, 1);
          broadcast({ type: "message_delete", messageId });
        }
        break;
      }

      //  Yêu cầu đồng bộ tin nhắn
      case "sync_messages": {
        ws.send(
          JSON.stringify({
            type: "sync_messages",
            messages,
          })
        );
        break;
      }

      //  User online / offline
      case "user_online": {
        const uid = data.uid;
        const u = users.find((x) => x.uid === uid);
        if (u) {
          u.isOnline = true;
          broadcast({ type: "user_online", uid });
        }
        break;
      }

      case "user_offline": {
        const uid = data.uid;
        const u = users.find((x) => x.uid === uid);
        if (u) {
          u.isOnline = false;
          broadcast({ type: "user_offline", uid });
        }
        break;
      }
    }
  });

  //  Khi client ngắt kết nối
  ws.on("close", () => {
    console.log(" Client disconnected");

    for (let [uid, connection] of connectedUsers.entries()) {
      if (connection === ws) {
        const user = users.find((u) => u.uid === uid);
        if (user) {
          user.isOnline = false;
          broadcast({ type: "user_offline", uid });
        }
        connectedUsers.delete(uid);
        break;
      }
    }
  });
});


sub.subscribe("chat_channel");
sub.on("message", async (channel, message) => {
  const msgData = JSON.parse(message);
  const recipientWs = connectedUsers.get(msgData.to);

  if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
    recipientWs.send(JSON.stringify({ type: "message", message: msgData }));
  } else {
    await pub.rpush(`offline:${msgData.to}`, JSON.stringify(msgData));
    console.log(`Lưu tin nhắn offline cho user ${msgData.to}`);
  }

  broadcast({ type: "message", message: msgData });
});

console.log("Server with Redis Pub/Sub ready!");
