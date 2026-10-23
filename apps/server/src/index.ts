import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { createStore } from "./db.ts";
import { acceptDeviceUpgrade } from "./device-relay.ts";

const config = readConfig();
const db = await createStore({
  dataDir: `${config.dataDir}/postgres`,
  databaseUrl: config.databaseUrl,
});
await db.recoverInterruptedActions();
const { app, agent, device, relay } = await createApp(db, config);
if (config.taskWorkerEnabled) agent.start();
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () =>
  console.log(`OpenMuse ${config.mode} API ready at ${config.publicUrl}`),
);
// Paired-phone WS relay: the APK dials outbound wss://<host>/api/devices/register
// with ?code=ot-pair-* (first pair, exchanged for a persistent token over the
// socket) or ?token=ot-dev-* (reconnect). No inbound port reaches the phone.
server.on("upgrade", (req, socket, head) => {
  void acceptDeviceUpgrade(req, socket, head, device, relay, config.deviceEnabled === true).then(
    (adopted) => {
      if (!adopted) socket.destroy();
    },
  );
});
const shutdown = () => {
  server.close(() => {
    void agent
      .stop()
      .then(() => db.close())
      .then(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
