const WebSocket = require("ws");
const wss = new WebSocket.Server({ port: 8080 });

let users = [];
let messages = [];

wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    switch (data.type) {
      case "connect":
        const user = data.user;
        if (!users.find((u) => u.uid === user.uid)) users.push(user);

        ws.send(
          JSON.stringify({
            type: "init",
            users: users.filter((u) => u.uid !== user.uid),
            messages,
          })
        );

        broadcast({ type: "new_user", user }, ws);
        break;

      case "message":
        const msgData = data.message;
        messages.push(msgData);
        broadcast({ type: "message", message: msgData });
        break;
    }
  });

  ws.on("close", () => console.log("Client disconnected"));
});

function broadcast(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}
