const WebSocket = require("ws");
const Redis = require("ioredis");

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const pub = new Redis(redisUrl);
const sub = new Redis(redisUrl);

const wss = new WebSocket.Server({ port: 8080 }, () => {
  console.log("WebSocket Server is running on port 8080");
});

const connectedUsers = new Map();

function broadcast(data, excludeWs = null) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
      client.send(JSON.stringify(data));
    }
  });
}

// Khi client kết nối
wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", async (msg) => {
    const data = JSON.parse(msg);

    switch (data.type) {
      case "connect": {
        const user = data.user;
        user.isOnline = true;

        // Lưu user vào Redis
        await pub.hset("user", user.uid, JSON.stringify(user));

        // Lấy toàn bộ user từ Redis để gửi init
        const allUsers = await pub.hgetall("user");
        const userList = Object.values(allUsers).map((u) => JSON.parse(u));
        ws.send(JSON.stringify({ type: "init_users", users: userList }));

        // Lưu WebSocket cho user
        connectedUsers.set(user.uid, ws);

        // Gửi offline messages cá nhân
        const offlineMsgs = await pub.lrange(`offline:${user.uid}`, 0, -1);
        for (const m of offlineMsgs) {
          ws.send(JSON.stringify({ type: "message", message: JSON.parse(m) }));
        }
        await pub.del(`offline:${user.uid}`);

        // Gửi offline messages global
        const globalOfflineMsgs = await pub.lrange(`offline:global`, 0, -1);
        for (const m of globalOfflineMsgs) {
          ws.send(JSON.stringify({ type: "message", message: JSON.parse(m) }));
        }

        broadcast({ type: "new_user", user }, ws);
        broadcast({ type: "user_online", uid: user.uid }, ws);

        break;
      }

      case "message": {
        const msgData = data.message;
        if (!msgData.timestamp) msgData.timestamp = new Date().toISOString();

        // Publish message qua Redis
        pub.publish("chat_channel", JSON.stringify(msgData));
        break;
      }

      case "message_update": {
        const updated = data.message;
        // Publish update qua Redis để mọi server/client nhận
        pub.publish(
          "chat_channel",
          JSON.stringify({ ...updated, _type: "update" })
        );
        break;
      }

      case "message_delete": {
        const messageId = data.messageId;
        pub.publish(
          "chat_channel",
          JSON.stringify({ id: messageId, _type: "delete" })
        );
        break;
      }

      case "user_online": {
        const uid = data.uid;
        const userStr = await pub.hget("user", uid);
        if (userStr) {
          const user = JSON.parse(userStr);
          user.isOnline = true;
          await pub.hset("user", uid, JSON.stringify(user));
          ws.send(JSON.stringify({ type: "user_online", uid: user.uid }));
          broadcast({ type: "user_online", uid });
        }
        break;
      }

      case "user_offline": {
        const uid = data.uid;
        const userStr = await pub.hget("user", uid);
        if (userStr) {
          const user = JSON.parse(userStr);
          user.isOnline = false;
          await pub.hset("user", uid, JSON.stringify(user));
          broadcast({ type: "user_offline", uid });
        }
        break;
      }
    }
  });

  // Khi client ngắt kết nối
  ws.on("close", async () => {
    console.log("Client disconnected");

    for (let [uid, connection] of connectedUsers.entries()) {
      if (connection === ws) {
        connectedUsers.delete(uid);
        const userStr = await pub.hget("user", uid);
        if (userStr) {
          const user = JSON.parse(userStr);
          user.isOnline = false;
          await pub.hset("user", uid, JSON.stringify(user));
          broadcast({ type: "user_offline", uid });
        }
        break;
      }
    }
  });
});

// Xử lý tin nhắn từ Redis Pub/Sub
sub.subscribe("chat_channel");
sub.on("message", async (channel, message) => {
  const msgData = JSON.parse(message);

  // Nếu là update hoặc delete
  if (msgData._type === "update") {
    broadcast({ type: "message_update", message: msgData });
    return;
  }
  if (msgData._type === "delete") {
    broadcast({ type: "message_delete", messageId: msgData.id });
    return;
  }

  // Tin nhắn global/group
  if (msgData.isGroup || msgData.roomId === "global") {
    broadcast({ type: "message", message: msgData });
    await pub.rpush(`offline:global`, JSON.stringify(msgData));
    return;
  }

  // Tin nhắn cá nhân
  const receiverId = msgData.receiverId;
  if (!receiverId) return;

  const recipientWs = connectedUsers.get(receiverId);
  if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
    recipientWs.send(JSON.stringify({ type: "message", message: msgData }));
  } else {
    await pub.rpush(`offline:${receiverId}`, JSON.stringify(msgData));
  }

  const senderWs = connectedUsers.get(msgData.senderId);
  if (senderWs && senderWs.readyState === WebSocket.OPEN) {
    senderWs.send(JSON.stringify({ type: "message", message: msgData }));
  }
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

console.log("Server with Redis Pub/Sub ready!");
