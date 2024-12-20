import { Jetstream } from "@skyware/jetstream";
import fs from "node:fs";
import { FastifyInstance } from "fastify";
import { AppContext } from "./index.js";
import { addUser, deleteProfile, getUser, updateUser } from "./db/user.js";
import { addRoom, deleteRoom, getRoom, updateRoom } from "./db/room.js";
import { addMessage, deleteMessage, updateMessage } from "./db/message.js";
import { Message, Room } from "./utils/types.js";

// TODO: proper validation

export function startJetstream(server: FastifyInstance, ctx: AppContext) {
  let intervalID: NodeJS.Timeout;
  const cursorFile = fs.readFileSync("cursor.txt", "utf8");
  if (cursorFile) ctx.logger.info(`Initiate jetstream at cursor ${cursorFile}`);

  const jetstream = new Jetstream({
    wantedCollections: ["social.psky.*"],
    endpoint: "wss://jetstream2.us-east.bsky.network/subscribe",
    cursor: Number(cursorFile),
  });

  jetstream.on("error", (err) => ctx.logger.error(err));
  jetstream.on("close", () => clearInterval(intervalID));

  jetstream.on("open", () => {
    intervalID = setInterval(() => {
      if (jetstream.cursor) {
        fs.writeFile("cursor.txt", jetstream.cursor.toString(), (err) => {
          if (err) console.log(err);
        });
      }
    }, 60000);
  });

  jetstream.on("social.psky.actor.profile", async (event) => {
    try {
      if (event.commit.operation === "delete") await deleteProfile(event.did);
      else await updateUser({ did: event.did, profile: event.commit.record });
    } catch (err) {
      ctx.logger.error(err, JSON.stringify(event));
    }
  });

  jetstream.on("social.psky.chat.message", async (event) => {
    try {
      const uri = `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`;
      let record;
      if (event.commit.operation === "delete") {
        const res = await deleteMessage(uri);
        record = {
          $type: "social.psky.chat.message#delete",
          did: event.did,
          rkey: event.commit.rkey,
          room: res?.room,
        };
      } else {
        let user = await getUser(event.did);
        if (!user) user = await addUser({ did: event.did });
        const room = await getRoom(event.commit.record.room);
        // TODO: fetch record from repo if room not found
        if (!room) return;
        if (
          (room.owner_did !== event.did &&
            room.allowlist?.active &&
            !room.allowlist.users.includes(event.did)) ||
          (room.owner_did !== event.did &&
            room.denylist?.active &&
            room.denylist.users.includes(event.did))
        ) {
          ctx.logger.warn(`Message ignored from ${event.did} in ${room.uri}`);
          return;
        }
        const msg: Message = {
          uri: uri,
          cid: event.commit.cid,
          did: event.did,
          msg: event.commit.record,
        };
        if (event.commit.operation === "create") await addMessage(msg);
        else await updateMessage(msg);
        record = {
          $type:
            event.commit.operation === "create" ?
              "social.psky.chat.message#create"
            : "social.psky.chat.message#update",
          did: event.did,
          rkey: event.commit.rkey,
          cid: event.commit.cid,
          content: event.commit.record.content,
          room: event.commit.record.room,
          facets: event.commit.record.facets,
          reply: event.commit.record.reply,
          handle: user!.handle,
          nickname: user!.nickname,
          indexedAt: Date.now(),
          updatedAt:
            event.commit.operation === "update" ? Date.now() : undefined,
        };
      }
      server.websocketServer.emit("message", JSON.stringify(record));
    } catch (err) {
      ctx.logger.error(err, JSON.stringify(event));
    }
  });

  jetstream.on("social.psky.chat.room", async (event) => {
    try {
      const uri = `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`;
      let record;
      if (event.commit.operation === "delete") {
        await deleteRoom(uri);
        record = { $type: "social.psky.chat.room#delete", event: event };
      } else {
        const user = await updateUser({ did: event.did });
        if (!user) return;
        const room: Room = {
          uri: uri,
          cid: event.commit.cid,
          owner: event.did,
          room: event.commit.record,
        };
        const res =
          event.commit.operation === "create" ?
            await addRoom(room)
          : await updateRoom(room);
        if (!res) return;
        record = {
          $type:
            event.commit.operation === "create" ?
              "social.psky.chat.room#create"
            : "social.psky.chat.room#update",
          record: event,
        };
      }
      server.websocketServer.emit("message", JSON.stringify(record));
    } catch (err) {
      ctx.logger.error(err, JSON.stringify(event));
    }
  });

  jetstream.on("identity", async (event) => {
    try {
      const user = await getUser(event.did);
      if (user !== undefined && event.identity.handle !== user.handle) {
        await ctx.db
          .updateTable("users")
          .set({ handle: event.identity.handle, updated_at: Date.now() })
          .where("did", "=", event.did)
          .executeTakeFirstOrThrow();
        ctx.logger.info(
          `Updated ${user.did}: ${user.handle} -> ${event.identity.handle}`,
        );
      }
    } catch (err) {
      ctx.logger.error(err, JSON.stringify(event));
    }
  });

  jetstream.on("account", async (event) => {
    const did = event.account.did;
    try {
      const user = await getUser(event.did);
      if (user === undefined) return;
      if (!event.account.active && event.account.status === "deleted") {
        await ctx.db
          .deleteFrom("users")
          .where("did", "=", did)
          .executeTakeFirstOrThrow();
        ctx.logger.info(`Deleted account: ${did}`);
      } else if (!event.account.active && event.account.status) {
        await ctx.db
          .updateTable("users")
          .set({ active: 0, updated_at: Date.now() })
          .where("did", "=", did)
          .executeTakeFirstOrThrow();
        ctx.logger.info(`Disabled account (${event.account.status}): ${did}`);
      } else if (event.account.active && !user.active) {
        await ctx.db
          .updateTable("users")
          .set({ active: 1, updated_at: Date.now() })
          .where("did", "=", did)
          .executeTakeFirstOrThrow();
        ctx.logger.info(`Reactivated account: ${did}`);
      }
    } catch (err) {
      ctx.logger.error(err, JSON.stringify(event));
    }
  });

  jetstream.start();
}
